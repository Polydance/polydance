package net.polydance.capture

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * 3D models a thread's launch opens (docs/THREADS.md, Models): fetched from the receiver through the
 * thread, kept in this app's private files by their sha256 and checked against it before the viewer
 * (ModelView) is given one. The receiver checked the file when the team pushed it; the hash here is
 * what ties the copy on the headset to the message. Plain Kotlin and java.io, so the JVM tests run it.
 */
object Models {
    /** The largest model a launch may name, as the receiver's MODEL_MAX_BYTES (src/glb.ts). */
    const val MAX_BYTES = 60L * 1024 * 1024
    private val SHA256 = Regex("[0-9a-f]{64}")
    private val NAME = Regex("[^/\\\\\\u0000-\\u001f]{1,116}\\.[gG][lL][bB]")

    /** Whether a model step's fields are ones this build will fetch and show; the receiver checks the same. */
    fun validStep(sha256: String, name: String, bytes: Long) =
        SHA256.matches(sha256) && NAME.matches(name) && name.trim() == name && bytes in 1..MAX_BYTES

    /** 4.2 MB or 640 kB, as the CLI says it (megabytes in src/threads.ts). */
    fun size(bytes: Long): String = if (bytes < 1_000_000) "${maxOf(1, Math.round(bytes / 1e3))} kB" else String.format(java.util.Locale.US, "%.1f MB", bytes / 1e6)

    fun file(dir: File, sha256: String): File {
        require(SHA256.matches(sha256)) { "not a model's sha256" }
        return File(File(dir, "models"), "$sha256.glb")
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** True when [file] is this model: its size, its hash, and the binary glTF magic. */
    fun matches(file: File, sha256: String, bytes: Long): Boolean =
        file.isFile && file.length() == bytes && isGlb(file) && sha256(file) == sha256

    fun isGlb(file: File): Boolean = file.inputStream().use { input ->
        val head = ByteArray(8)
        input.read(head) == 8 && head[0] == 'g'.code.toByte() && head[1] == 'l'.code.toByte() && head[2] == 'T'.code.toByte() && head[3] == 'F'.code.toByte() && head[4].toInt() == 2
    }

    /**
     * The model in [dir], fetched with [fetch] (which writes at most its limit into the file it is given)
     * when there is no good copy yet. A copy that fails the check is deleted, never shown.
     */
    fun obtain(dir: File, sha256: String, bytes: Long, fetch: (File) -> Unit): File {
        val target = file(dir, sha256)
        if (target.exists() && matches(target, sha256, bytes)) return target.also { it.setLastModified(System.currentTimeMillis()); prune(it.parentFile!!) }
        target.parentFile!!.mkdirs()
        val part = File(target.parentFile, "$sha256.part")
        try {
            fetch(part)
            if (!matches(part, sha256, bytes)) throw IOException("the model that arrived is not the one the message names")
            if (!part.renameTo(target)) throw IOException("could not keep the model")
            prune(target.parentFile!!)
            return target
        } finally {
            part.delete()
        }
    }

    /** Copies are only a cache of the receiver's: the [keep] most recently opened stay, the rest go. */
    fun prune(models: File, keep: Int = 8) {
        models.listFiles { f -> f.name.endsWith(".glb") }.orEmpty().sortedByDescending { it.lastModified() }.drop(keep).forEach { it.delete() }
    }

    /** How the viewer page says it is doing, through its title (assets/viewer/viewer.js). */
    sealed class PageState {
        data class Loading(val progress: Float?) : PageState()
        data class Loaded(val animations: Int) : PageState()
        data class Failed(val reason: String) : PageState()
    }

    fun pageState(title: String?): PageState = when {
        title == null -> PageState.Loading(null)
        title.startsWith("progress ") -> PageState.Loading(title.removePrefix("progress ").toFloatOrNull()?.coerceIn(0f, 1f))
        title.startsWith("loaded ") -> PageState.Loaded(title.removePrefix("loaded ").substringBefore(' ').toIntOrNull() ?: 0)
        title.startsWith("error ") -> PageState.Failed(when (val why = title.removePrefix("error ")) {
            "loadfailure" -> "the viewer could not read this model"
            "webglcontextlost" -> "the headset's graphics stopped; close and open it again"
            "no model" -> "no model was named"
            else -> why.take(120)
        })
        else -> PageState.Loading(null)
    }
}
