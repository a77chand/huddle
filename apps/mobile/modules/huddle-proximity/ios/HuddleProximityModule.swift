import CoreBluetooth
import ExpoModulesCore

public class HuddleProximityModule: Module {
  private var engine: ProximityEngine?

  public func definition() -> ModuleDefinition {
    Name("HuddleProximity")

    Events("onSighting", "onState")

    /// Advertise `token` under `service`; scan for `scanMs` out of every `periodMs`.
    AsyncFunction("start") { (service: String, token: String, scanMs: Double, periodMs: Double) in
      guard let s = UUID(uuidString: service), let t = UUID(uuidString: token) else {
        throw InvalidUuidException()
      }
      if self.engine == nil {
        self.engine = ProximityEngine { [weak self] name, body in
          self?.sendEvent(name, body)
        }
      }
      self.engine?.start(service: CBUUID(nsuuid: s), token: CBUUID(nsuuid: t), scanMs: scanMs, periodMs: periodMs)
    }

    /// Rotate to a new ID without stopping the scan.
    Function("setToken") { (token: String) in
      guard let t = UUID(uuidString: token) else { throw InvalidUuidException() }
      self.engine?.setToken(CBUUID(nsuuid: t))
    }

    Function("stop") {
      self.engine?.stop()
    }

    Function("state") { () -> String in
      self.engine?.stateName ?? "unknown"
    }

    OnDestroy {
      self.engine?.stop()
    }
  }
}

final class InvalidUuidException: Exception {
  override var reason: String { "service and token must be UUID strings" }
}

/// Owns both Bluetooth roles. All CoreBluetooth work happens on one serial queue.
///
/// A foreground iPhone advertises [service, token]. A backgrounded one can only be
/// found by service UUID (iOS moves extra UUIDs to a hashed overflow area), so a
/// GATT characteristic also serves the token and scanners read it on demand.
///
/// Battery: scanning runs in short bursts (default 10 s every 2 min) without
/// duplicate reports; iOS chooses the advertising interval itself.
final class ProximityEngine: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate, CBPeripheralDelegate {
  static let tokenCharacteristic = CBUUID(string: "7A6E0002-4875-6464-6C65-50524F580001")
  /// Re-read a phone's token over GATT at most this often.
  static let gattReadInterval: TimeInterval = 300
  /// Report the same token to JS at most this often.
  static let emitInterval: TimeInterval = 20

  private let queue = DispatchQueue(label: "dev.huddle.proximity")
  private let emit: (String, [String: Any]) -> Void
  private var central: CBCentralManager?
  private var peripheral: CBPeripheralManager?
  private var service: CBUUID?
  private var token: CBUUID?
  private var running = false
  private var connecting: [UUID: CBPeripheral] = [:]
  private var connectingRssi: [UUID: Int] = [:]
  private var lastRead: [UUID: Date] = [:]
  private var lastEmit: [String: Date] = [:]
  private var scanSeconds: TimeInterval = 10
  private var periodSeconds: TimeInterval = 120
  private var burstTimer: DispatchSourceTimer?

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
  }

  var stateName: String {
    guard let c = central else { return "unknown" }
    switch c.state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    default: return "unknown"
    }
  }

  func start(service: CBUUID, token: CBUUID, scanMs: Double, periodMs: Double) {
    queue.async {
      self.service = service
      self.token = token
      self.scanSeconds = min(max(scanMs / 1000, 2), 60)
      self.periodSeconds = min(max(periodMs / 1000, self.scanSeconds), 900)
      self.running = true
      if self.central == nil {
        self.central = CBCentralManager(delegate: self, queue: self.queue)
      } else {
        self.startScanning()
      }
      if self.peripheral == nil {
        self.peripheral = CBPeripheralManager(delegate: self, queue: self.queue)
      } else {
        self.publish()
      }
    }
  }

  func setToken(_ token: CBUUID) {
    queue.async {
      self.token = token
      self.publish()
    }
  }

  func stop() {
    queue.async {
      self.running = false
      self.burstTimer?.cancel()
      self.burstTimer = nil
      self.central?.stopScan()
      self.peripheral?.stopAdvertising()
      self.peripheral?.removeAllServices()
      for p in self.connecting.values { self.central?.cancelPeripheralConnection(p) }
      self.connecting.removeAll()
    }
  }

  // MARK: - Scanning (central)

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    emit("onState", ["state": stateName])
    if central.state == .poweredOn { startScanning() }
  }

  /// (Re)start the burst schedule: scan now for scanSeconds, repeat every periodSeconds.
  private func startScanning() {
    guard running, central?.state == .poweredOn else { return }
    burstTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: periodSeconds)
    timer.setEventHandler { [weak self] in self?.scanBurst() }
    timer.resume()
    burstTimer = timer
  }

  private func scanBurst() {
    guard running, let s = service, let c = central, c.state == .poweredOn else { return }
    c.scanForPeripherals(withServices: [s], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    queue.asyncAfter(deadline: .now() + scanSeconds) { [weak self] in
      guard let self, self.running else { return }
      self.central?.stopScan()
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
    guard running else { return }
    let uuids = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    if let t = uuids.first(where: { $0 != service && $0.data.count == 16 }) {
      sighted(t.uuidString, rssi.intValue)
      return
    }
    // No token in the advertisement: ask for it over GATT, rate-limited per phone.
    let now = Date()
    if connecting[p.identifier] != nil { return }
    if let last = lastRead[p.identifier], now.timeIntervalSince(last) < Self.gattReadInterval { return }
    lastRead[p.identifier] = now
    connecting[p.identifier] = p
    connectingRssi[p.identifier] = rssi.intValue
    p.delegate = self
    central.connect(p)
    queue.asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self, let pending = self.connecting[p.identifier] else { return }
      self.central?.cancelPeripheralConnection(pending)
      self.connecting[p.identifier] = nil
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
    guard let s = service else { return central.cancelPeripheralConnection(p) }
    p.discoverServices([s])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    connecting[p.identifier] = nil
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
    connecting[p.identifier] = nil
  }

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard let svc = p.services?.first(where: { $0.uuid == service }) else { return finish(p) }
    p.discoverCharacteristics([Self.tokenCharacteristic], for: svc)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
    guard let ch = svc.characteristics?.first(where: { $0.uuid == Self.tokenCharacteristic }) else { return finish(p) }
    p.readValue(for: ch)
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
    if error == nil, let data = ch.value, data.count == 16 {
      sighted(CBUUID(data: data).uuidString, connectingRssi[p.identifier] ?? 0)
    }
    finish(p)
  }

  private func finish(_ p: CBPeripheral) {
    central?.cancelPeripheralConnection(p)
    connecting[p.identifier] = nil
  }

  private func sighted(_ token: String, _ rssi: Int) {
    let now = Date()
    let key = token.uppercased()
    if let last = lastEmit[key], now.timeIntervalSince(last) < Self.emitInterval { return }
    lastEmit[key] = now
    emit("onSighting", ["token": key, "rssi": rssi, "at": now.timeIntervalSince1970 * 1000])
  }

  // MARK: - Advertising (peripheral)

  func peripheralManagerDidUpdateState(_ pm: CBPeripheralManager) {
    if pm.state == .poweredOn { publish() }
  }

  private func publish() {
    guard running, let pm = peripheral, pm.state == .poweredOn, let s = service else { return }
    pm.stopAdvertising()
    pm.removeAllServices()
    let ch = CBMutableCharacteristic(type: Self.tokenCharacteristic, properties: [.read], value: nil, permissions: [.readable])
    let svc = CBMutableService(type: s, primary: true)
    svc.characteristics = [ch]
    pm.add(svc)  // advertising starts once the service is added
  }

  func peripheralManager(_ pm: CBPeripheralManager, didAdd svc: CBService, error: Error?) {
    guard error == nil, running, let s = service, let t = token else { return }
    pm.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [s, t]])
  }

  func peripheralManager(_ pm: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard request.characteristic.uuid == Self.tokenCharacteristic, let t = token else {
      return pm.respond(to: request, withResult: .attributeNotFound)
    }
    let data = t.data
    guard request.offset <= data.count else { return pm.respond(to: request, withResult: .invalidOffset) }
    request.value = data.subdata(in: request.offset..<data.count)
    pm.respond(to: request, withResult: .success)
  }
}
