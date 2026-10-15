package dev.leanreview.credentials;

import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/** Secrets remain in process memory or the OS store, never application persistence. */
@Service
public class CredentialVault {
  public interface Persistent {
    void set(String account, String token) throws Exception;

    String get(String account) throws Exception;
  }

  private final Persistent persistent;
  private final ConcurrentHashMap<String, String> session = new ConcurrentHashMap<>();

  public CredentialVault(Persistent persistent) {
    this.persistent = persistent;
  }

  public synchronized void set(String account, String token, boolean persist) {
    if (!persist) {
      session.put(account, token);
      return;
    }
    try {
      persistent.set(account, token);
      session.remove(account);
    } catch (Exception | LinkageError unavailable) {
      throw new IllegalArgumentException(
          "OS credential storage is unavailable or locked. Select session-only storage"
              + " explicitly.");
    }
  }

  public String get(String account, boolean allowPersistent) {
    String token = session.get(account);
    if (token != null || !allowPersistent) return token;
    try {
      return persistent.get(account);
    } catch (Exception | LinkageError unavailable) {
      return null;
    }
  }
}
