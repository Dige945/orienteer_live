package com.orienteer.tracker

import android.content.Context
import java.io.File

class QueuedLocationStore(context: Context) {
    private val file = File(context.filesDir, "queued-locations.jsonl")

    @Synchronized
    fun append(payload: String) {
        file.appendText(payload.trim() + "\n")
    }

    @Synchronized
    fun readAll(): List<String> {
        if (!file.exists()) return emptyList()
        return file.readLines().filter { it.isNotBlank() }
    }

    @Synchronized
    fun replaceRemaining(remaining: List<String>) {
        if (remaining.isEmpty()) {
            file.delete()
        } else {
            file.writeText(remaining.joinToString(separator = "\n", postfix = "\n"))
        }
    }
}
