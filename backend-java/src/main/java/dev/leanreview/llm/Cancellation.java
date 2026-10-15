package dev.leanreview.llm;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

public final class Cancellation {
  private final AtomicBoolean canceled = new AtomicBoolean();
  private final java.util.Set<Runnable> callbacks = ConcurrentHashMap.newKeySet();

  public boolean canceled() {
    return canceled.get();
  }

  public void check() {
    if (canceled()) throw new IllegalArgumentException("Analysis canceled.");
  }

  public AutoCloseable register(Runnable callback) {
    callbacks.add(callback);
    if (canceled() && callbacks.remove(callback)) callback.run();
    return () -> callbacks.remove(callback);
  }

  public void cancel() {
    if (!canceled.compareAndSet(false, true)) return;
    callbacks.forEach(
        callback -> {
          try {
            callback.run();
          } catch (RuntimeException ignored) {
          }
        });
    callbacks.clear();
  }
}
