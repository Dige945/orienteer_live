package com.orienteer.tracker

import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

data class JoinResult(val eventId: String, val runnerId: String, val uploadToken: String)
data class EventInfo(val id: String, val code: String, val name: String)

object JoinApi {
    @Volatile
    var lastError: String = ""
        private set

    fun eventInfo(serverUrl: String, eventIdOrCode: String): EventInfo? {
        lastError = ""
        val endpoint = "${serverUrl.trimEnd('/')}/api/mobile/events/${eventIdOrCode.trim()}"
        return runCatching {
            val connection = URL(endpoint).openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            val code = connection.responseCode
            val body = readBody(connection, code)
            connection.disconnect()
            if (code !in 200..299) {
                lastError = "赛事查询失败 HTTP $code：${body.take(120)}"
                return@runCatching null
            }
            val event = JSONObject(body).getJSONObject("event")
            EventInfo(
                id = event.optString("id"),
                code = event.optString("code"),
                name = event.optString("name")
            ).takeIf { it.id.isNotBlank() && it.name.isNotBlank() }
        }.onFailure { error ->
            lastError = "赛事查询失败：${error.javaClass.simpleName} ${error.message ?: endpoint}"
        }.getOrNull()
    }

    fun join(
        serverUrl: String,
        eventIdOrCode: String,
        name: String,
        deviceId: String
    ): JoinResult? {
        lastError = ""
        val endpoint = "${serverUrl.trimEnd('/')}/api/mobile/join"
        val payload = JSONObject()
            .put("eventId", eventIdOrCode)
            .put("eventCode", eventIdOrCode)
            .put("name", name)
            .put("deviceId", deviceId)
            .toString()

        return runCatching {
            val connection = URL(endpoint).openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            OutputStreamWriter(connection.outputStream).use { it.write(payload) }
            val code = connection.responseCode
            val body = readBody(connection, code)
            connection.disconnect()
            if (code !in 200..299) {
                lastError = "加入失败 HTTP $code：${body.take(120)}"
                return@runCatching null
            }
            val json = JSONObject(body)
            val resolvedEventId = json.getJSONObject("event").optString("id")
            val runner = json.getJSONObject("runner")
            val runnerId = runner.optString("id")
            val uploadToken = runner.optString("uploadToken")
            if (resolvedEventId.isNotBlank() && runnerId.isNotBlank() && uploadToken.isNotBlank()) {
                JoinResult(resolvedEventId, runnerId, uploadToken)
            } else {
                lastError = "加入失败：服务器返回缺少参赛者信息"
                null
            }
        }.onFailure { error ->
            lastError = "加入失败：${error.javaClass.simpleName} ${error.message ?: endpoint}"
        }.getOrNull()
    }

    private fun readBody(connection: HttpURLConnection, code: Int): String {
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        return stream?.bufferedReader()?.use { it.readText() }.orEmpty()
    }
}
