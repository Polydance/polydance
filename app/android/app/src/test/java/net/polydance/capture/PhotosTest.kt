package net.polydance.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest

/** A message's photos on the headset: which ones it takes, the cached copy it trusts, and how far to shrink one. */
class PhotosTest {
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + "rest of a png".toByteArray()
    private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte()) + "rest of a jpeg".toByteArray()
    private fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    private fun photo(data: ByteArray, type: String) = Threads.Photo(sha(data), type, 1170, 2532, data.size.toLong())
    private fun dir() = Files.createTempDirectory("photos").toFile()

    @Test fun takesOnlyAJpegOrPngNamedByItsHashWithinTheLimits() {
        val sha = "a".repeat(64)
        assertTrue(Photos.valid(sha, "image/jpeg", 4096, 1, 20_000_000))
        assertTrue(Photos.valid(sha, "image/png", 1, 4096, 1))
        assertFalse(Photos.valid("A".repeat(64), "image/jpeg", 10, 10, 10))
        assertFalse(Photos.valid(sha.dropLast(1), "image/jpeg", 10, 10, 10))
        assertFalse(Photos.valid(sha, "image/heic", 10, 10, 10))
        assertFalse(Photos.valid(sha, "image/jpeg", 4097, 10, 10))
        assertFalse(Photos.valid(sha, "image/jpeg", 10, 0, 10))
        assertFalse(Photos.valid(sha, "image/jpeg", 10, 10, 0))
        assertFalse(Photos.valid(sha, "image/jpeg", 10, 10, Photos.MAX_BYTES + 1))
    }

    @Test fun fetchesOnceAndKeepsOnlyACopyThatIsThePhotoNamed() {
        val dir = dir()
        val wanted = photo(png, "image/png")
        var fetches = 0
        val file = Photos.obtain(dir, wanted) { part -> fetches++; part.writeBytes(png) }
        assertEquals(File(File(dir, "photos"), "${wanted.sha256}.png"), file)
        assertTrue(file.readBytes().contentEquals(png))
        Photos.obtain(dir, wanted) { fetches++ }
        assertEquals("a good copy is not fetched again", 1, fetches)

        // Something else under the photo's name: refused, and nothing is kept.
        val other = photo(jpeg, "image/jpeg")
        try {
            Photos.obtain(dir, other) { part -> part.writeBytes(png) }
            fail("a different file was kept")
        } catch (e: IOException) {
            assertEquals("the photo that arrived is not the one the message names", e.message)
        }
        assertFalse(Photos.file(dir, other).exists())
        assertTrue(File(dir, "photos").listFiles().orEmpty().none { it.name.endsWith(".part") })
        // The right bytes but not the type the message says.
        try { Photos.obtain(dir, other.copy(type = "image/png")) { part -> part.writeBytes(jpeg) }; fail("the wrong type was kept") } catch (_: IOException) {}

        // A damaged copy is fetched again.
        file.writeBytes(png.copyOf(png.size - 1) + byteArrayOf(0))
        Photos.obtain(dir, wanted) { part -> fetches++; part.writeBytes(png) }
        assertEquals(2, fetches)
    }

    @Test fun keepsTheMostRecentlyDrawn() {
        val photos = File(dir(), "photos").apply { mkdirs() }
        (0 until 5).forEach { i -> File(photos, "$i.jpg").apply { writeText("x"); setLastModified(1_000_000L * (i + 1)) } }
        File(photos, "notes.txt").writeText("not a photo")
        Photos.prune(photos, keep = 2)
        assertEquals(listOf("3.jpg", "4.jpg", "notes.txt"), photos.list().orEmpty().sorted())
    }

    @Test fun shrinksByAPowerOfTwoAndNoFurtherThanTheTarget() {
        assertEquals(1, Photos.sampleSize(300, 200, 300))
        assertEquals("2532 / 4 is 633, still at least 600", 4, Photos.sampleSize(1170, 2532, 600))
        assertEquals(8, Photos.sampleSize(4096, 3072, 300))
        assertEquals(1, Photos.sampleSize(4096, 3072, 4096))
        assertEquals("a target of nothing is one pixel", 4096, Photos.sampleSize(4096, 4096, 0))
    }

    @Test fun saysHowManyAndHowBig() {
        assertEquals("Photo", Photos.words(1))
        assertEquals("3 photos", Photos.words(3))
        assertEquals("1170×2532 · 1.2 MB", Photos.describe(Threads.Photo("a".repeat(64), "image/jpeg", 1170, 2532, 1_234_567)))
    }
}
