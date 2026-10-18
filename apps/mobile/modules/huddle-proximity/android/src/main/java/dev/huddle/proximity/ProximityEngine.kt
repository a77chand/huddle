package dev.huddle.proximity

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.nio.ByteBuffer
import java.util.UUID

/**
 * Both Bluetooth roles. State is only touched on the main looper; Bluetooth
 * callbacks arrive on binder threads and post back to it.
 *
 * Advertisement layout: the fixed Huddle service UUID in the advertisement and
 * the rotating ID in the scan response (two 128-bit UUIDs don't fit in 31 bytes).
 * A GATT characteristic also serves the ID, for scanners that only see the
 * service UUID (e.g. a backgrounded iPhone advertiser).
 */
@SuppressLint("MissingPermission") // checked in hasPermissions() before any Bluetooth call
class ProximityEngine(
  private val context: Context,
  private val emit: (String, Map<String, Any?>) -> Unit,
) {
  companion object {
    val TOKEN_CHARACTERISTIC: UUID = UUID.fromString("7A6E0002-4875-6464-6C65-50524F580001")
    const val GATT_READ_INTERVAL_MS = 300_000L
    const val EMIT_INTERVAL_MS = 20_000L
    const val CONNECT_TIMEOUT_MS = 10_000L
  }

  private val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val main = Handler(Looper.getMainLooper())
  private var service: UUID? = null
  @Volatile private var token: UUID? = null
  private var running = false
  private var advertising = false
  private var scanning = false
  private var gattServer: BluetoothGattServer? = null
  private val lastRead = HashMap<String, Long>()
  private val lastEmit = HashMap<String, Long>()
  private val connecting = HashMap<String, BluetoothGatt>()

  fun start(service: UUID, token: UUID) = main.post {
    this.service = service
    this.token = token
    running = true
    val state = stateName()
    emit("onState", mapOf("state" to state))
    if (state != "poweredOn") return@post
    startServer()
    restartAdvertising()
    startScanning()
  }

  fun setToken(token: UUID) = main.post {
    this.token = token
    if (running) restartAdvertising()
  }

  fun stop() = main.post {
    running = false
    if (hasPermissions()) {
      stopAdvertising()
      stopScanning()
      gattServer?.close()
      connecting.values.forEach { it.close() }
    }
    gattServer = null
    connecting.clear()
  }

  fun stateName(): String {
    val adapter = manager.adapter ?: return "unsupported"
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return "unsupported"
    if (!hasPermissions()) return "unauthorized"
    return if (adapter.isEnabled) "poweredOn" else "poweredOff"
  }

  private fun hasPermissions(): Boolean {
    val needed =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
      } else {
        listOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }
    return needed.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
  }

  // ---- Advertising + GATT server (peripheral) ----

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartFailure(errorCode: Int) {
      main.post {
        advertising = false
        emit("onState", mapOf("state" to "advertiseFailed", "code" to errorCode))
      }
    }
  }

  private fun restartAdvertising() {
    stopAdvertising()
    val s = service ?: return
    val t = token ?: return
    val advertiser = manager.adapter?.bluetoothLeAdvertiser ?: return
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(true)
      .build()
    val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(s)).build()
    val response = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(t)).build()
    advertiser.startAdvertising(settings, data, response, advertiseCallback)
    advertising = true
  }

  private fun stopAdvertising() {
    if (!advertising) return
    manager.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback)
    advertising = false
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      val server = gattServer ?: return
      val bytes = token?.let(::toBytes)
      when {
        characteristic.uuid != TOKEN_CHARACTERISTIC || bytes == null ->
          server.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        offset > bytes.size ->
          server.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
        else ->
          server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, bytes.copyOfRange(offset, bytes.size))
      }
    }
  }

  private fun startServer() {
    if (gattServer != null) return
    val s = service ?: return
    val server = manager.openGattServer(context, serverCallback) ?: return
    val svc = BluetoothGattService(s, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    svc.addCharacteristic(
      BluetoothGattCharacteristic(
        TOKEN_CHARACTERISTIC,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ,
      ),
    )
    server.addService(svc)
    gattServer = server
  }

  // ---- Scanning (central) ----

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      main.post { handle(result) }
    }

    override fun onBatchScanResults(results: MutableList<ScanResult>) {
      main.post { results.forEach(::handle) }
    }

    override fun onScanFailed(errorCode: Int) {
      main.post {
        scanning = false
        emit("onState", mapOf("state" to "scanFailed", "code" to errorCode))
      }
    }
  }

  private fun startScanning() {
    if (scanning) return
    val s = service ?: return
    val scanner = manager.adapter?.bluetoothLeScanner ?: return
    val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(s)).build())
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
    scanner.startScan(filters, settings, scanCallback)
    scanning = true
  }

  private fun stopScanning() {
    if (!scanning) return
    manager.adapter?.bluetoothLeScanner?.stopScan(scanCallback)
    scanning = false
  }

  private fun handle(result: ScanResult) {
    if (!running) return
    val uuids = result.scanRecord?.serviceUuids?.map { it.uuid } ?: emptyList()
    val t = uuids.firstOrNull { it != service }
    if (t != null) sighted(t, result.rssi) else readOverGatt(result.device, result.rssi)
  }

  private fun readOverGatt(device: BluetoothDevice, rssi: Int) {
    val address = device.address
    val now = System.currentTimeMillis()
    if (connecting.containsKey(address) || now - (lastRead[address] ?: 0L) < GATT_READ_INTERVAL_MS) return
    lastRead[address] = now
    val callback = object : BluetoothGattCallback() {
      override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
        if (newState == BluetoothProfile.STATE_CONNECTED) {
          gatt.discoverServices()
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
          gatt.close()
          main.post { connecting.remove(address) }
        }
      }

      override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
        val ch = service?.let { gatt.getService(it) }?.getCharacteristic(TOKEN_CHARACTERISTIC)
        if (ch == null || !gatt.readCharacteristic(ch)) gatt.disconnect()
      }

      // Android 13+
      override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
        done(gatt, value, status)
      }

      // Android 12 and below
      @Deprecated("Replaced on Android 13 by the overload with a value parameter")
      override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
        @Suppress("DEPRECATION")
        done(gatt, characteristic.value, status)
      }

      private fun done(gatt: BluetoothGatt, value: ByteArray?, status: Int) {
        if (status == BluetoothGatt.GATT_SUCCESS && value != null && value.size == 16) {
          val uuid = fromBytes(value)
          main.post { sighted(uuid, rssi) }
        }
        gatt.disconnect()
      }
    }
    val gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE) ?: return
    connecting[address] = gatt
    main.postDelayed({ connecting[address]?.disconnect() }, CONNECT_TIMEOUT_MS)
  }

  private fun sighted(token: UUID, rssi: Int) {
    val key = token.toString().uppercase()
    val now = System.currentTimeMillis()
    if (now - (lastEmit[key] ?: 0L) < EMIT_INTERVAL_MS) return
    lastEmit[key] = now
    emit("onSighting", mapOf("token" to key, "rssi" to rssi, "at" to now.toDouble()))
  }

  private fun toBytes(u: UUID): ByteArray =
    ByteBuffer.allocate(16).putLong(u.mostSignificantBits).putLong(u.leastSignificantBits).array()

  private fun fromBytes(b: ByteArray): UUID {
    val buf = ByteBuffer.wrap(b)
    return UUID(buf.long, buf.long)
  }
}
