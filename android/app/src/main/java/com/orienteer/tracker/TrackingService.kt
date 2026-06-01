package com.orienteer.tracker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

class TrackingService : Service() {
    private lateinit var locationManager: LocationManager
    private lateinit var queue: QueuedLocationStore
    private val executor = Executors.newSingleThreadExecutor()
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private var locationListener: LocationListener? = null
    private var lastLocation: Location? = null
    private var heartbeatRunnable: Runnable? = null
    private var serverUrl: String = ""
    private var eventId: String = ""
    private var runnerId: String = ""
    private var uploadToken: String = ""
    private var intervalMillis: Long = 2000L
    private var uploadCount: Long = 0L

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        queue = QueuedLocationStore(this)
        ensureNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                serverUrl = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty().trimEnd('/')
                eventId = intent.getStringExtra(EXTRA_EVENT_ID).orEmpty()
                runnerId = intent.getStringExtra(EXTRA_RUNNER_ID).orEmpty()
                uploadToken = intent.getStringExtra(EXTRA_UPLOAD_TOKEN).orEmpty()
                intervalMillis = (intent.getLongExtra(EXTRA_INTERVAL_SECONDS, 2L).coerceAtLeast(1L)) * 1000L
                lastLocation = newestLastKnownLocation()
                startForeground(NOTIFICATION_ID, buildNotification("已启动，等待定位上传"))
                startLocationUpdates()
                startHeartbeat()
                flushQueued()
            }
            ACTION_STOP -> {
                stopLocationUpdates()
                stopHeartbeat()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopLocationUpdates()
        executor.shutdown()
        super.onDestroy()
    }

    private fun startLocationUpdates() {
        if (!hasLocationPermission() || serverUrl.isBlank() || eventId.isBlank() || runnerId.isBlank() || uploadToken.isBlank()) return
        stopLocationUpdates()

        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                lastLocation = location
                uploadLocation(location, location.time)
            }

            @Deprecated("Deprecated in Android SDK")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) = Unit
        }
        locationListener = listener

        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        var requested = false
        for (provider in providers) {
            if (locationManager.isProviderEnabled(provider)) {
                locationManager.requestLocationUpdates(provider, intervalMillis, 0f, listener, mainLooper)
                locationManager.getLastKnownLocation(provider)?.let { listener.onLocationChanged(it) }
                requested = true
            }
        }
        if (!requested) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, buildNotification("没有可用定位，请打开 GPS 或网络定位"))
        }
    }

    private fun stopLocationUpdates() {
        locationListener?.let { locationManager.removeUpdates(it) }
        locationListener = null
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatRunnable = object : Runnable {
            override fun run() {
                val location = lastLocation ?: newestLastKnownLocation()
                if (location != null) {
                    lastLocation = location
                    uploadLocation(location, System.currentTimeMillis())
                } else {
                    notifyUpload("等待定位结果，尚未上传")
                }
                heartbeatHandler.postDelayed(this, intervalMillis)
            }
        }
        heartbeatHandler.postDelayed(heartbeatRunnable!!, intervalMillis)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { heartbeatHandler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    private fun newestLastKnownLocation(): Location? {
        if (!hasLocationPermission()) return null
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .mapNotNull { provider ->
                runCatching {
                    if (locationManager.isProviderEnabled(provider)) locationManager.getLastKnownLocation(provider) else null
                }.getOrNull()
            }
            .maxByOrNull { it.time }
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun buildPayload(location: Location, timestamp: Long = location.time): String {
        return JSONObject()
            .put("eventId", eventId)
            .put("runnerId", runnerId)
            .put("uploadToken", uploadToken)
            .put("lat", location.latitude)
            .put("lng", location.longitude)
            .put("coordSystem", "WGS84")
            .put("accuracy", location.accuracy)
            .put("speed", if (location.hasSpeed()) location.speed else 0f)
            .put("heading", if (location.hasBearing()) location.bearing else 0f)
            .put("timestamp", timestamp)
            .toString()
    }

    private fun postSingle(payload: String): Boolean {
        return postJson("$serverUrl/api/location/report", payload)
    }

    private fun uploadLocation(location: Location, timestamp: Long) {
        val payload = buildPayload(location, timestamp = timestamp)
        executor.execute {
            val ok = postSingle(payload)
            if (ok) {
                uploadCount += 1
                notifyUpload("上传成功 #$uploadCount ${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.CHINA).format(java.util.Date())}")
                flushQueued(limit = 10)
            } else {
                queue.append(payload)
                notifyUpload("上传失败，已缓存")
            }
        }
    }

    private fun flushQueued(limit: Int = 10) {
        val queued = queue.readLatest(limit)
        if (queued.isEmpty()) return
        val points = org.json.JSONArray()
        queued.forEach { points.put(JSONObject(it)) }
        val batchPayload = JSONObject().put("points", points).toString()

        if (postJson("$serverUrl/api/location/batch-report", batchPayload)) {
            queue.replaceRemaining(emptyList())
        }
    }

    private fun postJson(endpoint: String, payload: String): Boolean {
        return runCatching {
            val connection = URL(endpoint).openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            OutputStreamWriter(connection.outputStream).use { it.write(payload) }
            val code = connection.responseCode
            if (code in 200..299) {
                connection.inputStream.close()
            } else {
                connection.errorStream?.close()
            }
            connection.disconnect()
            code in 200..299
        }.getOrDefault(false)
    }

    private fun notifyUpload(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.tracking_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun buildNotification(text: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.tracking_running))
            .setContentText(text)
            .setOngoing(true)
            .build()

    companion object {
        const val ACTION_START = "com.orienteer.tracker.START"
        const val ACTION_STOP = "com.orienteer.tracker.STOP"
        const val EXTRA_SERVER_URL = "serverUrl"
        const val EXTRA_EVENT_ID = "eventId"
        const val EXTRA_RUNNER_ID = "runnerId"
        const val EXTRA_UPLOAD_TOKEN = "uploadToken"
        const val EXTRA_INTERVAL_SECONDS = "intervalSeconds"
        private const val CHANNEL_ID = "orienteer-tracking"
        private const val NOTIFICATION_ID = 1
    }
}
