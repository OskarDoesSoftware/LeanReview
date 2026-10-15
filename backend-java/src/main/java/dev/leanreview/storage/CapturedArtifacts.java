package dev.leanreview.storage;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class CapturedArtifacts {
  private final Path directory;

  public CapturedArtifacts(DatabaseOwner owner, @Value("${leanreview.data-directory}") String root)
      throws IOException {
    directory = Path.of(root).resolve("cache");
    Files.createDirectories(directory);
  }

  public static String digest(String text) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  public String read(String digest) throws IOException {
    if (digest == null || !digest.matches("[a-f0-9]{64}"))
      throw new IOException("Invalid captured artifact identity.");
    Path file = directory.resolve(digest);
    if (!Files.exists(file)) throw new IOException("Captured artifact is missing: " + digest + ".");
    String text;
    try {
      text =
          StandardCharsets.UTF_8
              .newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(Files.readAllBytes(file)))
              .toString();
    } catch (CharacterCodingException error) {
      throw new IOException("Captured artifact is corrupt: " + digest + ".", error);
    }
    if (!digest(text).equals(digest))
      throw new IOException("Captured artifact is corrupt: " + digest + ".");
    return text;
  }

  public String write(String text) throws IOException {
    String digest = digest(text);
    Path file = directory.resolve(digest);
    if (Files.exists(file)) {
      read(digest);
      return digest;
    }
    Path temporary = Files.createTempFile(directory, ".artifact-", ".tmp");
    try {
      Files.writeString(temporary, text, StandardCharsets.UTF_8);
      try (var channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
        channel.force(true);
      }
      try {
        Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
      } catch (AtomicMoveNotSupportedException error) {
        throw new IOException("Captured artifact storage requires atomic file moves.", error);
      }
    } finally {
      Files.deleteIfExists(temporary);
    }
    return digest;
  }
}
