package net.polydance.capture

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Photos in a thread's messages (docs/THREADS.md, Photos, 2026-11-07): fetched from the receiver through the
 * thread, kept in this app's private files by their sha256 and checked against it before one is drawn. The
 * receiver checked and stripped each photo, and sends them upright, so BitmapFactory (which ignores EXIF
 * orientation) draws them the right way up. Plain Kotlin and java.io, so the JVM tests run it, as Models.
 */
object Photos {
    /** The receiver's ceiling on a photo (PHOTO_CEILING_BYTES in src/photo.ts) and its longest side. */
    const val MAX_BYTES = 60L * 1024 * 1024
    const val MAX_SIDE = 4096
    /** At most this many copies stay; the least recently drawn go first. */
    const val KEEP = 48
    private val SHA256 = Regex("[0-9a-f]{64}")
    private val EXTENSIONS = mapOf("image/jpeg" to "jpg", "image/png" to "png")

    /** Whether a photo's fields are ones this build will fetch and draw; the receiver checks the same. */
    fun valid(sha256: String, type: String, width: Int, height: Int, bytes: Long) =
        SHA256.matches(sha256) && type in EXTENSIONS && width in 1..MAX_SIDE && height in 1..MAX_SIDE && bytes in 1..MAX_BYTES

    fun file(dir: File, photo: Threads.Photo): File {
        require(SHA256.matches(photo.sha256)) { "not a photo's sha256" }
        val ext = EXTENSIONS[photo.type] ?: throw IllegalArgumentException("not a photo's type")
        return File(File(dir, "photos"), "${photo.sha256}.$ext")
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Whether the file starts as its type does: JPEG's FF D8 FF, or PNG's signature. */
    fun looksLike(file: File, type: String): Boolean = file.inputStream().use { input ->
        val head = ByteArray(8)
        val n = input.read(head)
        when (type) {
            "image/jpeg" -> n >= 3 && head[0] == 0xff.toByte() && head[1] == 0xd8.toByte() && head[2] == 0xff.toByte()
            "image/png" -> n == 8 && head.contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
            else -> false
        }
    }

    /** True when [file] is this photo: its size, its type's first bytes and its hash. */
    fun matches(file: File, photo: Threads.Photo): Boolean =
        file.isFile && file.length() == photo.bytes && looksLike(file, photo.type) && sha256(file) == photo.sha256

    /**
     * The photo in [dir], fetched with [fetch] (which writes at most its size into the file it is given) when
     * there is no good copy yet. A copy that fails the check is deleted, never drawn.
     */
    fun obtain(dir: File, photo: Threads.Photo, fetch: (File) -> Unit): File {
        val target = file(dir, photo)
        if (target.exists() && matches(target, photo)) return target.also { it.setLastModified(System.currentTimeMillis()) }
        target.parentFile!!.mkdirs()
        val part = File(target.parentFile, "${photo.sha256}.part")
        try {
            fetch(part)
            if (!matches(part, photo)) throw IOException("the photo that arrived is not the one the message names")
            if (!part.renameTo(target)) throw IOException("could not keep the photo")
            prune(target.parentFile!!)
            return target
        } finally {
            part.delete()
        }
    }

    /** Copies are only a cache of the receiver's: the [keep] most recently drawn stay, the rest go. */
    fun prune(photos: File, keep: Int = KEEP) {
        photos.listFiles { f -> f.name.endsWith(".jpg") || f.name.endsWith(".png") }.orEmpty().sortedByDescending { it.lastModified() }.drop(keep).forEach { it.delete() }
    }

    /** The power of two to shrink by when decoding, so the longer side is still at least [target] pixels. */
    fun sampleSize(width: Int, height: Int, target: Int): Int {
        var size = 1
        while (maxOf(width, height) / (size * 2) >= maxOf(1, target)) size *= 2
        return size
    }

    /** "Photo", "3 photos", for a folded message's line. */
    fun words(count: Int): String = if (count == 1) "Photo" else "$count photos"

    /** "1170×2532 · 1.2 MB", under a photo opened large. */
    fun describe(photo: Threads.Photo): String = "${photo.width}×${photo.height} · ${Models.size(photo.bytes)}"
}
