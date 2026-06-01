package com.orienteer.tracker

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val permissionRequestCode = 1001
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var statusText: TextView
    private lateinit var statusPill: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var eventNameText: TextView
    private lateinit var scanPreview: PreviewView
    private lateinit var imagePicker: ActivityResultLauncher<String>
    private var cameraProvider: ProcessCameraProvider? = null
    private var scannedOnce = false
    private var connectedEvent: EventInfo? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val serverInput = EditText(this).apply {
            hint = "服务器地址"
            setText("http://")
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_NEXT
            setFieldStyle()
        }
        val eventInput = EditText(this).apply {
            hint = "赛事码"
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_NEXT
            setFieldStyle()
        }
        val nameInput = EditText(this).apply {
            hint = "姓名"
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_DONE
            setFieldStyle()
        }
        imagePicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null) decodeQrFromImage(uri, serverInput, eventInput)
        }

        statusText = TextView(this).apply {
            text = "请先扫描网页里的 App 接入二维码。扫码成功后会自动显示赛事名称。"
            setTextColor(MUTED)
            textSize = 14f
            setLineSpacing(dp(2).toFloat(), 1.0f)
        }
        statusPill = TextView(this).apply {
            text = "未连接"
            setTextColor(MUTED)
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = roundedStroke(SOFT, LINE, dp(999))
        }
        eventNameText = TextView(this).apply {
            text = "未选择赛事"
            setTextColor(TEXT)
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
        }
        scanPreview = PreviewView(this).apply {
            visibility = View.GONE
            background = roundedStroke(0xFFFFE8C7.toInt(), LINE, dp(12))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(260)
            ).apply {
                bottomMargin = dp(12)
            }
        }
        startButton = Button(this).apply {
            text = "开始息屏定位"
            setPrimaryButton()
        }
        stopButton = Button(this).apply {
            text = "停止定位"
            setSecondaryButton()
        }

        val scanButton = Button(this).apply {
            text = "扫码加入赛事"
            setPrimaryButton()
        }
        val pickQrButton = Button(this).apply {
            text = "从相册识别二维码"
            setSecondaryButton()
        }
        val manualButton = Button(this).apply {
            text = "手动输入"
            setCompactButton()
        }
        val connectButton = Button(this).apply {
            text = "连接赛事"
            setSecondaryButton()
        }
        val manualPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(label("服务器地址"))
            addView(serverInput)
            addView(space(12))
            addView(label("赛事码"))
            addView(eventInput)
            addView(space(12))
            addView(connectButton)
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(28))
            setBackgroundColor(BACKGROUND)
            addView(header())
            addView(card {
                addView(sectionTitle("扫码加入"))
                addView(scanPreview)
                addView(scanButton)
                addView(space(10))
                addView(pickQrButton)
                addView(space(10))
                addView(manualButton)
                addView(space(12))
                addView(manualPanel)
            })
            addView(card {
                addView(sectionTitle("赛事"))
                addView(eventNameText)
                addView(space(12))
                addView(label("姓名"))
                addView(nameInput)
                addView(space(16))
                addView(startButton)
                addView(space(10))
                addView(stopButton)
            })
            addView(card {
                addView(sectionTitle("运行状态"))
                addView(statusRow())
                addView(space(10))
                addView(statusText)
            })
        }

        setContentView(ScrollView(this).apply {
            setBackgroundColor(BACKGROUND)
            addView(content)
        })

        requestRuntimePermissions()
        applyDeepLink(serverInput, eventInput)
        if (serverInput.text.toString().trim() != "http://" && eventInput.text.toString().trim().isNotBlank()) {
            connectEvent(serverInput.text.toString(), eventInput.text.toString())
        }

        scanButton.setOnClickListener {
            scannedOnce = false
            scanPreview.visibility = View.VISIBLE
            setStatus("请对准网页“手机接入”里的二维码。", false, "扫码中")
            startScanner(serverInput, eventInput)
        }

        pickQrButton.setOnClickListener {
            stopScanner()
            scanPreview.visibility = View.GONE
            imagePicker.launch("image/*")
        }

        manualButton.setOnClickListener {
            manualPanel.visibility = if (manualPanel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }

        connectButton.setOnClickListener {
            connectEvent(serverInput.text.toString(), eventInput.text.toString())
        }

        startButton.setOnClickListener {
            val serverUrl = serverInput.text.toString().trim()
            val eventIdOrCode = eventInput.text.toString().trim()
            val runnerName = nameInput.text.toString().trim()
            if (connectedEvent == null) {
                setStatus("请先扫码或手动连接赛事。", false, "未连接")
                return@setOnClickListener
            }
            if (runnerName.isBlank()) {
                setStatus("请填写姓名。", false, "待填写")
                return@setOnClickListener
            }
            if (!hasForegroundLocationPermission()) {
                setStatus("缺少定位权限，请允许定位后再开始。", false, "缺权限")
                requestRuntimePermissions()
                return@setOnClickListener
            }
            if (Build.VERSION.SDK_INT >= 29 && !hasBackgroundLocationPermission()) {
                setStatus("需要后台定位权限，请在系统设置里选择始终允许。", false, "缺权限")
                openAppSettings()
                return@setOnClickListener
            }

            setBusy(true)
            setStatus("正在加入赛事...", true, "连接中")
            executor.execute {
                val result = JoinApi.join(
                    serverUrl = serverUrl,
                    eventIdOrCode = eventIdOrCode,
                    name = runnerName,
                    deviceId = getOrCreateDeviceId()
                )
                runOnUiThread {
                    setBusy(false)
                    if (result == null) {
                        setStatus(JoinApi.lastError.ifBlank { "加入失败，请检查赛事码和网络。" }, false, "失败")
                        return@runOnUiThread
                    }
                    val intent = Intent(this, TrackingService::class.java).apply {
                        action = TrackingService.ACTION_START
                        putExtra(TrackingService.EXTRA_SERVER_URL, serverUrl)
                        putExtra(TrackingService.EXTRA_EVENT_ID, result.eventId)
                        putExtra(TrackingService.EXTRA_RUNNER_ID, result.runnerId)
                        putExtra(TrackingService.EXTRA_UPLOAD_TOKEN, result.uploadToken)
                    }
                    ContextCompat.startForegroundService(this, intent)
                    setStatus("已连接，定位上传运行中。", true, "运行中")
                }
            }
        }

        stopButton.setOnClickListener {
            startService(Intent(this, TrackingService::class.java).apply {
                action = TrackingService.ACTION_STOP
            })
            setStatus("定位已停止。", false, "已停止")
        }
    }

    override fun onDestroy() {
        stopScanner()
        executor.shutdown()
        super.onDestroy()
    }

    private fun connectEvent(serverUrlRaw: String, eventIdOrCodeRaw: String) {
        val serverUrl = serverUrlRaw.trim()
        val eventIdOrCode = eventIdOrCodeRaw.trim()
        if (serverUrl.isBlank() || serverUrl == "http://") {
            setStatus("没有服务器地址。请扫码，或点手动输入。", false, "未连接")
            return
        }
        if (eventIdOrCode.isBlank()) {
            setStatus("没有赛事码。请扫码，或点手动输入。", false, "未连接")
            return
        }
        setBusy(true)
        setStatus("正在连接赛事...", true, "连接中")
        executor.execute {
            val eventInfo = JoinApi.eventInfo(serverUrl, eventIdOrCode)
            runOnUiThread {
                setBusy(false)
                if (eventInfo == null) {
                    connectedEvent = null
                    eventNameText.text = "未选择赛事"
                    setStatus(JoinApi.lastError.ifBlank { "连接失败，请检查服务器地址、赛事码和网络。" }, false, "失败")
                    return@runOnUiThread
                }
                connectedEvent = eventInfo
                eventNameText.text = "${eventInfo.name}\n赛事码 ${eventInfo.code}"
                setStatus("已连接赛事，请填写姓名后开始定位。", false, "已连接")
            }
        }
    }

    private fun applyDeepLink(serverInput: EditText, eventInput: EditText) {
        val data = intent?.data ?: return
        val code = data.getQueryParameter("code") ?: data.getQueryParameter("eventCode")
        val server = data.getQueryParameter("server")
        if (!server.isNullOrBlank()) serverInput.setText(server)
        if (!code.isNullOrBlank()) eventInput.setText(code)
    }

    private fun applyQrValue(value: String, serverInput: EditText, eventInput: EditText) {
        val uri = runCatching { Uri.parse(value) }.getOrNull()
        val code = uri?.getQueryParameter("code") ?: uri?.getQueryParameter("eventCode")
        val server = uri?.getQueryParameter("server")
        if (server.isNullOrBlank() || code.isNullOrBlank()) {
            setStatus("二维码格式不对，请扫描网页“手机接入”里的二维码。", false, "扫码失败")
            return
        }
        serverInput.setText(server)
        eventInput.setText(code)
        stopScanner()
        scanPreview.visibility = View.GONE
        connectEvent(server, code)
    }

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    private fun startScanner(serverInput: EditText, eventInput: EditText) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), permissionRequestCode)
            return
        }
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val provider = providerFuture.get()
            cameraProvider = provider
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(scanPreview.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { proxy ->
                val mediaImage = proxy.image
                if (mediaImage == null || scannedOnce) {
                    proxy.close()
                    return@setAnalyzer
                }
                val value = runCatching {
                    decodeQr(
                        yPlane = mediaImage.planes[0].buffer.also { it.rewind() },
                        width = mediaImage.width,
                        height = mediaImage.height
                    )
                }.getOrNull()
                if (!value.isNullOrBlank() && !scannedOnce) {
                    scannedOnce = true
                    runOnUiThread { applyQrValue(value, serverInput, eventInput) }
                }
                proxy.close()
            }
            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    private fun decodeQr(yPlane: java.nio.ByteBuffer, width: Int, height: Int): String? {
        val data = ByteArray(yPlane.remaining())
        yPlane.get(data)
        val source = PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        val reader = MultiFormatReader().apply {
            setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(com.google.zxing.BarcodeFormat.QR_CODE)))
        }
        return reader.decodeWithState(bitmap).text
    }

    private fun decodeQrFromImage(uri: Uri, serverInput: EditText, eventInput: EditText) {
        setStatus("正在识别图片二维码...", true, "识别中")
        executor.execute {
            val value = runCatching {
                contentResolver.openInputStream(uri)?.use { input ->
                    val bitmap = BitmapFactory.decodeStream(input) ?: return@use null
                    val width = bitmap.width
                    val height = bitmap.height
                    val pixels = IntArray(width * height)
                    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
                    val source = RGBLuminanceSource(width, height, pixels)
                    val binaryBitmap = BinaryBitmap(HybridBinarizer(source))
                    val reader = MultiFormatReader().apply {
                        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(com.google.zxing.BarcodeFormat.QR_CODE)))
                    }
                    reader.decodeWithState(binaryBitmap).text
                }
            }.getOrNull()
            runOnUiThread {
                if (value.isNullOrBlank()) {
                    setStatus("没有识别到二维码，请换一张清晰图片。", false, "识别失败")
                } else {
                    applyQrValue(value, serverInput, eventInput)
                }
            }
        }
    }

    private fun stopScanner() {
        cameraProvider?.unbindAll()
        cameraProvider = null
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), permissionRequestCode)
        }
    }

    private fun hasForegroundLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasBackgroundLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:$packageName")
        })
    }

    private fun getOrCreateDeviceId(): String {
        val prefs = getSharedPreferences("tracker", MODE_PRIVATE)
        val existing = prefs.getString("deviceId", null)
        if (existing != null) return existing
        val created = UUID.randomUUID().toString()
        prefs.edit().putString("deviceId", created).apply()
        return created
    }

    private fun header(): LinearLayout {
        val title = TextView(this).apply {
            text = "定向定位"
            setTextColor(TEXT)
            textSize = 28f
            typeface = Typeface.DEFAULT_BOLD
        }
        val subtitle = TextView(this).apply {
            text = "扫码加入赛事，息屏继续上传位置"
            setTextColor(MUTED)
            textSize = 14f
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(title)
            addView(subtitle)
            addView(space(18))
        }
    }

    private fun card(children: LinearLayout.() -> Unit): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(17), dp(17), dp(17), dp(17))
            background = roundedStroke(Color.WHITE, LINE, dp(14))
            elevation = dp(2).toFloat()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = dp(14)
            }
            children()
        }
    }

    private fun sectionTitle(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(TEXT)
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, dp(12))
        }
    }

    private fun label(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(MUTED)
            textSize = 13f
            setPadding(0, 0, 0, dp(6))
        }
    }

    private fun statusRow(): LinearLayout {
        return LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(statusPill)
        }
    }

    private fun space(height: Int): TextView {
        return TextView(this).apply {
            layoutParams = LinearLayout.LayoutParams(1, dp(height))
        }
    }

    private fun EditText.setFieldStyle() {
        textSize = 16f
        setTextColor(TEXT)
        setHintTextColor(0xFF8A958C.toInt())
        setPadding(dp(12), dp(11), dp(12), dp(11))
        background = roundedStroke(0xFFFFFCF7.toInt(), LINE, dp(10))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
    }

    private fun Button.setPrimaryButton() {
        textSize = 16f
        setTextColor(Color.WHITE)
        setPadding(dp(12), dp(12), dp(12), dp(12))
        background = roundedStroke(ACCENT, ACCENT_DARK, dp(10))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
    }

    private fun Button.setSecondaryButton() {
        textSize = 16f
        setTextColor(ACCENT_DARK)
        setPadding(dp(12), dp(12), dp(12), dp(12))
        background = roundedStroke(SOFT, LINE, dp(10))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
    }

    private fun Button.setCompactButton() {
        textSize = 14f
        setTextColor(ACCENT_DARK)
        setPadding(dp(10), dp(9), dp(10), dp(9))
        background = roundedStroke(SOFT, LINE, dp(10))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
    }

    private fun setStatus(text: String, active: Boolean, pill: String) {
        statusText.text = text
        statusPill.text = pill
        statusPill.setTextColor(if (active) ACCENT else MUTED)
        statusPill.background = if (active) {
            roundedStroke(0xFFFFE7C2.toInt(), 0xFFF4B36B.toInt(), dp(999))
        } else {
            roundedStroke(SOFT, LINE, dp(999))
        }
    }

    private fun setBusy(busy: Boolean) {
        startButton.isEnabled = !busy
        stopButton.isEnabled = !busy
        startButton.alpha = if (busy) 0.65f else 1f
        stopButton.alpha = if (busy) 0.65f else 1f
    }

    private fun roundedStroke(fill: Int, stroke: Int, radius: Int): GradientDrawable {
        return GradientDrawable().apply {
            setColor(fill)
            cornerRadius = radius.toFloat()
            setStroke(dp(1), stroke)
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private val BACKGROUND = 0xFFFFF7ED.toInt()
        private val TEXT = 0xFF2B2118.toInt()
        private val MUTED = 0xFF7C6552.toInt()
        private val LINE = 0xFFF3D0A3.toInt()
        private val SOFT = 0xFFFFF1DC.toInt()
        private val ACCENT = 0xFFF28C28.toInt()
        private val ACCENT_DARK = 0xFFB45309.toInt()
    }
}
