package dev.huddle.proximity

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class HuddleProximityModule : Module() {
  private var engine: ProximityEngine? = null

  override fun definition() = ModuleDefinition {
    Name("HuddleProximity")

    Events("onSighting", "onState")

    /** Advertise `token` under `service` and scan for other phones advertising `service`. */
    AsyncFunction("start") { service: String, token: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val e = engine ?: ProximityEngine(context) { name, body -> sendEvent(name, body) }.also { engine = it }
      e.start(parse(service), parse(token))
    }

    /** Rotate to a new ID without stopping the scan. */
    Function("setToken") { token: String ->
      engine?.setToken(parse(token))
    }

    Function("stop") {
      engine?.stop()
    }

    Function("state") {
      engine?.stateName() ?: "unknown"
    }

    OnDestroy {
      engine?.stop()
    }
  }

  private fun parse(s: String): UUID =
    try {
      UUID.fromString(s)
    } catch (e: IllegalArgumentException) {
      throw CodedException("ERR_INVALID_UUID", "service and token must be UUID strings", e)
    }
}
