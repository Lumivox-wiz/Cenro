package com.lumivox.cenro

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.Gravity
import android.webkit.WebSettings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import java.io.File

/**
 * 文件管理器 / 微信「用其他应用打开」的落点。
 *
 * 只做一件事：把 content:// 指向的文件**复制进 `<files>/incoming`**，然后不管了。
 * 入库、抽封面、分类全在 Rust 侧，由它扫这个目录——两个平台共用同一条 `absorb`。
 *
 * 为什么不让 Rust 通过 JNI 主动来取（0.20.2 的做法）：
 * - `ndk-context` 取不到全局时是 `expect`，会 panic；
 * - `jni` 调用失败（比如方法找错了类）会在 Java 侧留下 pending 异常，
 *   主线程带着它返回 Java 层就直接崩。
 * 目录协议只有「扫得到 / 扫不到」两种结果，不会把应用带走。
 *
 * **先写 `.part` 再 rename**：rename 是原子的，Rust 侧跳过 `.part` 就永远读不到半截文件。
 *
 * 注意：这个文件在 `gen/android/` 下，属于仓库内容；重新 `tauri android init` 会覆盖它。
 */
private const val MIN_CHROME_MAJOR = 100

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    /*
     * WebView 太旧就直接换一块原生说明页。
     *
     * 这个项目构建目标是 chrome100（ES2020 + 若干新 CSS），
     * 而安卓的系统 WebView 由用户自行更新：从不更新的机器上可能是 Chrome 51，
     * 那时前端一行都跑不起来，用户看到的只有黑屏——和「应用坏了」没有区别。
     *
     * 判不出来（个别定制 ROM 的 UA 不标准）就放行：宁可让它在能看到错误的地方失败，
     * 也不要因为读不到版本号就把能用的设备挡在门外。
     */
    if (webViewTooOld()) {
      showOutdatedWebViewScreen()
      return
    }

    acceptIncoming(intent)
  }

  /** 系统 WebView 的 Chrome 主版本是否够用；读不到时按「够用」处理 */
  private fun webViewTooOld(): Boolean {
    return try {
      val ua = WebSettings.getDefaultUserAgent(this)
      val major = Regex("Chrome/(\\d+)").find(ua)?.groupValues?.get(1)?.toIntOrNull()
      major != null && major < MIN_CHROME_MAJOR
    } catch (e: Throwable) {
      false
    }
  }

  /**
   * 把黑屏换成一句能照做的话。
   *
   * 用框架自带的控件拼出来：此时 WebView 不可信，但原生视图一定画得出来。
   */
  private fun showOutdatedWebViewScreen() {
    val pad = (24 * resources.displayMetrics.density).toInt()
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(pad, pad, pad, pad)
      setBackgroundColor(Color.parseColor("#16171a"))
    }

    layout.addView(
      TextView(this).apply {
        text = "系统 WebView 版本过旧"
        textSize = 20f
        setTextColor(Color.parseColor("#e6e7e9"))
        gravity = Gravity.CENTER
      },
    )

    layout.addView(
      TextView(this).apply {
        text = "岑序需要 Chrome 100 及以上的 WebView 才能运行。\n" +
          "请到应用商店更新「Android System WebView」（部分机型更新「Chrome」），然后重新打开。"
        textSize = 14f
        setTextColor(Color.parseColor("#a0a3a9"))
        gravity = Gravity.CENTER
        setPadding(0, pad / 2, 0, pad)
      },
    )

    layout.addView(
      Button(this).apply {
        text = "打开应用商店"
        setOnClickListener {
          // 优先打开 WebView 自己的详情页，不行再退回 Chrome，避免直接把用户扔到商店首页
          val candidates = listOf(
            "market://details?id=com.google.android.webview",
            "market://details?id=com.android.chrome",
          )
          for (url in candidates) {
            try {
              startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
              return@setOnClickListener
            } catch (e: Throwable) {
              // 换下一个
            }
          }
        }
      },
    )

    setContentView(layout)
  }

  /**
   * launchMode 是 singleTask，应用已在前台时再次打开文件不会新建 Activity，
   * 而是走这里。冷启动走 onCreate，两条路都要收。
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    acceptIncoming(intent)
  }

  private fun acceptIncoming(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_VIEW) return
    val uri: Uri = intent.data ?: return

    /*
     * 目录与 Rust 侧的 `app_data_dir` 完全一致。
     *
     * 实测（日志里读出来的）：Tauri 在 Android 上**不给 app_data_dir 追加包名**，
     * 它就是 `getDataDir()` 本身：
     *   app_data_dir = /data/user/0/com.lumivox.cenro          ← Rust 扫这里
     *   filesDir     = /data/user/0/com.lumivox.cenro/files
     *   cacheDir     = /data/user/0/com.lumivox.cenro/cache
     * 之前两版分别多写/少写了一层包名，所以「能进应用但没书」。
     *
     * 用 applicationInfo.dataDir 而不是 getDataDir()：后者要 API 24，前者从 API 1 就有。
     */
    val dir = File(applicationInfo.dataDir, "incoming").apply { mkdirs() }
    val name = displayName(uri) ?: "book-${System.currentTimeMillis()}"
    val target = uniqueFile(dir, name)

    // 复制放到后台线程：几十 MB 的 PDF 在 UI 线程写会直接 ANR
    Thread {
      val part = File(target.parentFile, "${target.name}.part")
      try {
        // openInputStream 拿的是本次 intent 授予的临时读权限，复制完就不再依赖它
        contentResolver.openInputStream(uri)?.use { input ->
          part.outputStream().use { output -> input.copyTo(output) }
        } ?: return@Thread
        // rename 完成才算「这本能读了」
        if (!part.renameTo(target)) {
          part.delete()
        }
      } catch (e: Exception) {
        part.delete()
      }
    }.start()
  }

  /** content URI 的真实文件名在 OpenableColumns 里，url 末尾那串数字是媒体 id。 */
  private fun displayName(uri: Uri): String? {
    if (uri.scheme == "file") return uri.lastPathSegment
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (idx >= 0) return c.getString(idx)
        }
      }
    } catch (e: Exception) {
      // 查询被拒（某些定制系统）时退回 url 末段
    }
    return uri.lastPathSegment
  }

  /** 同名文件加序号，避免两次打开同一本书互相覆盖。 */
  private fun uniqueFile(dir: File, name: String): File {
    var file = File(dir, name)
    if (!file.exists()) return file
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var i = 1
    while (file.exists() && i < 1000) {
      file = File(dir, "$stem($i)$ext")
      i++
    }
    return file
  }
}
