package com.orienteer.tracker

import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

data class JoinResult(val eventId: String, val runnerId: String, val uploadToken: String)
data class EventInfo(val id: String, val code: String, val name: String)

object JoinApi {
    fun eventInfo(serverUrl: String, eventIdOrCode: String): EventInfo? {
        return runCatching {
            val connection = URL("${serverUrl.trimEnd('/')}/api/mobile/events/${eventIdOrCode.trim()}").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()
            val event = JSONObject(body).getJSONObject("event")
            EventInfo(
                id = event.optString("id"),
                code = event.optString("code"),
                name = event.optString("name")
            ).takeIf { it.id.isNotBlank() && it.name.isNotBlank() }
        }.getOrNull()
    }

    fun join(
        serverUrl: String,
        eventIdOrCode: String,
        name: String,
        deviceId: String
    ): JoinResult? {
        val payload = JSONObject()
            .put("eventId", eventIdOrCode)
            .put("eventCode", eventIdOrCode)
            .put("name", name)
            .put("deviceId", deviceId)
            .toString()

        return runCatching {
            val connection = URL("${serverUrl.trimEnd('/')}/api/mobile/join").openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            OutputStreamWriter(connection.outputStream).use { it.write(payload) }
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()
            val json = JSONObject(body)
            val resolvedEventId = json.getJSONObject("event").optString("id")
            val runner = json.getJSONObject("runner")
            val runnerId = runner.optString("id")
            val uploadToken = runner.optString("uploadToken")
            if (resolvedEventId.isNotBlank() && runnerId.isNotBlank() && uploadToken.isNotBlank()) {
                JoinResult(resolvedEventId, runnerId, uploadToken)
            } else {
                null
            }
        }.getOrNull()
    }
}
