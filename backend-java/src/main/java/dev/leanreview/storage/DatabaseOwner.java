package dev.leanreview.storage;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/** Holds ownership for the application's whole lifetime, including migration. */
public final class DatabaseOwner implements AutoCloseable {
  private final FileChannel channel;
  private final FileLock lock;

  public DatabaseOwner(Path directory) throws IOException {
    Files.createDirectories(directory);
    channel =
        FileChannel.open(
            directory.resolve("leanreview.lock"),
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE);
    FileLock acquired;
    try {
      acquired = channel.tryLock();
    } catch (OverlappingFileLockException | IOException error) {
      channel.close();
      throw new IOException(
          "Another Java backend owns this data directory. Stop it before starting or migrating.",
          error);
    }
    if (acquired == null) {
      channel.close();
      throw new IOException(
          "Another Java backend owns this data directory. Stop it before starting or migrating.");
    }
    lock = acquired;
  }

  @Override
  public void close() throws IOException {
    try {
      lock.release();
    } finally {
      channel.close();
    }
  }
}
