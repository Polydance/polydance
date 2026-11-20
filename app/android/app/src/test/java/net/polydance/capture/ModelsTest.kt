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

/** The viewer's side of a model step: which ones it takes, the cached copy it trusts, and what the page says. */
class ModelsTest {
    /** A minimal file with the binary glTF 2 header; the viewer page reads the rest. */
    private fun glb(extra: String = "x"): ByteArray = byteArrayOf(0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0) + extra.toByteArray()
    private fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    private fun dir() = Files.createTempDirectory("models").toFile()

    @Test fun takesOnlyAModelNamedByItsHashAndAFileName() {
        val sha = "a".repeat(64)
        assertTrue(Models.validStep(sha, "Oak chair.glb", 4_200_000))
        assertTrue(Models.validStep(sha, "CHAIR.GLB", 1))
        assertFalse(Models.validStep("A".repeat(64), "chair.glb", 10))
        assertFalse(Models.validStep(sha.dropLast(1), "chair.glb", 10))
        assertFalse(Models.validStep(sha, "../chair.glb", 10))
        assertFalse(Models.validStep(sha, "chair.gltf", 10))
        assertFalse(Models.validStep(sha, " chair.glb", 10))
        assertFalse(Models.validStep(sha, "chair.glb", 0))
        assertFalse(Models.validStep(sha, "chair.glb", Models.MAX_BYTES + 1))
    }

    @Test fun fetchesOnceAndKeepsOnlyACopyThatIsTheModelNamed() {
        val dir = dir()
        val data = glb()
        var fetches = 0
        val file = Models.obtain(dir, sha(data), data.size.toLong()) { part -> fetches++; part.writeBytes(data) }
        assertEquals(File(File(dir, "models"), "${sha(data)}.glb"), file)
        assertTrue(file.readBytes().contentEquals(data))
        Models.obtain(dir, sha(data), data.size.toLong()) { fetches++ }
        assertEquals(1, fetches)

        // Something else arriving under that name is refused and nothing is kept.
        val other = glb("y")
        try {
            Models.obtain(dir, sha(other), other.size.toLong()) { part -> part.writeBytes(glb("z")) }
            fail("a copy with another hash was kept")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("not the one the message names"))
        }
        assertFalse(Models.file(dir, sha(other)).exists())
        assertEquals(listOf("${sha(data)}.glb"), File(dir, "models").list()!!.sorted())

        // A damaged cached copy is fetched again.
        file.writeBytes(glb("tampered"))
        Models.obtain(dir, sha(data), data.size.toLong()) { part -> fetches++; part.writeBytes(data) }
        assertEquals(2, fetches)
    }

    @Test fun aFileWithoutTheGltfHeaderIsNotAModel() {
        val dir = dir()
        val text = "not a model".toByteArray()
        try {
            Models.obtain(dir, sha(text), text.size.toLong()) { it.writeBytes(text) }
            fail("a file that is not a .glb was kept")
        } catch (_: IOException) {}
    }

    @Test fun keepsOnlyTheMostRecentlyOpenedCopies() {
        val models = File(dir(), "models").apply { mkdirs() }
        (1..10).forEach { i -> File(models, "$i.glb").apply { writeText("x"); setLastModified(i * 1000L) } }
        Models.prune(models, keep = 3)
        assertEquals(listOf("10.glb", "8.glb", "9.glb"), models.list()!!.sorted())
    }

    @Test fun readsWhatTheViewerPageSays() {
        assertEquals(Models.PageState.Loading(null), Models.pageState("loading"))
        assertEquals(Models.PageState.Loading(0.42f), Models.pageState("progress 0.42"))
        assertEquals(Models.PageState.Loaded(2), Models.pageState("loaded 2 animations"))
        assertEquals(Models.PageState.Failed("the viewer could not read this model"), Models.pageState("error loadfailure"))
        assertEquals(Models.PageState.Failed("something else"), Models.pageState("error something else"))
    }

    @Test fun saysSizesAsTheCliDoes() {
        assertEquals("4.2 MB", Models.size(4_200_000))
        assertEquals("640 kB", Models.size(640_000))
        assertEquals("1 kB", Models.size(12))
    }
}
