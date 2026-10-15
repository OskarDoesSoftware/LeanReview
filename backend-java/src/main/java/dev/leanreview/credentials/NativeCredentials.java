package dev.leanreview.credentials;

import com.github.javakeyring.Keyring;
import com.github.javakeyring.KeyringStorageType;
import com.sun.jna.*;
import com.sun.jna.ptr.PointerByReference;
import com.sun.jna.win32.StdCallLibrary;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
public class NativeCredentials implements CredentialVault.Persistent {
  private boolean windows() {
    return System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win");
  }

  private Keyring keyring() throws Exception {
    String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
    if (os.contains("mac")) return Keyring.create(KeyringStorageType.OSX_KEYCHAIN);
    if (os.contains("linux")) return Keyring.create(KeyringStorageType.GNOME_KEYRING);
    throw new IllegalStateException("OS credential store is unavailable.");
  }

  public void set(String account, String token) throws Exception {
    if (System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("linux")) {
      try (var collection = new com.github.javakeyring.internal.freedesktop.SimpleCollection()) {
        var attributes = Map.of("service", "LeanReview", "username", account);
        var items = collection.getItems(attributes);
        if (items == null) items = List.of();
        if (items.size() > 1) throw new IllegalStateException("Ambiguous credential.");
        if (items.isEmpty()) collection.createItem("LeanReview " + account, token, attributes);
        else collection.updateItem(items.getFirst(), "LeanReview " + account, token, attributes);
      }
      return;
    }
    if (!windows()) {
      try (var keyring = keyring()) {
        keyring.setPassword("LeanReview", account, token);
      }
      return;
    }
    byte[] bytes = token.getBytes(StandardCharsets.UTF_16LE);
    if (bytes.length > 2560 || bytes.length == 0)
      throw new IllegalArgumentException("Credential is outside native size limits.");
    try (Memory memory = new Memory(bytes.length)) {
      memory.write(0, bytes, 0, bytes.length);
      Credential credential = new Credential();
      credential.type = 1;
      credential.target = new WString(account + ".LeanReview");
      credential.user = new WString(account);
      credential.blob = memory;
      credential.blobSize = bytes.length;
      credential.persist = 3;
      try {
        if (!api().CredWriteW(credential, 0))
          throw new IllegalStateException("OS credential storage is unavailable.");
      } finally {
        memory.clear();
      }
    } finally {
      Arrays.fill(bytes, (byte) 0);
    }
  }

  public String get(String account) throws Exception {
    if (System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("linux")) {
      try (var collection = new com.github.javakeyring.internal.freedesktop.SimpleCollection()) {
        var items = collection.getItems(Map.of("service", "LeanReview", "username", account));
        if (items == null) items = List.of();
        if (items.size() > 1) throw new IllegalStateException("Ambiguous credential.");
        if (items.isEmpty()) return null;
        char[] secret = collection.getSecret(items.getFirst());
        try {
          return new String(secret);
        } finally {
          Arrays.fill(secret, '\0');
        }
      }
    }
    if (!windows()) {
      try (var keyring = keyring()) {
        return keyring.getPassword("LeanReview", account);
      }
    }
    PointerByReference reference = new PointerByReference();
    if (!api().CredReadW(new WString(account + ".LeanReview"), 1, 0, reference)) return null;
    Credential credential = new Credential(reference.getValue());
    byte[] bytes = null;
    try {
      if (credential.blobSize < 0 || credential.blobSize > 2560 || credential.blobSize % 2 != 0)
        throw new IllegalStateException("Invalid credential.");
      bytes = credential.blob.getByteArray(0, credential.blobSize);
      return new String(bytes, StandardCharsets.UTF_16LE);
    } finally {
      if (bytes != null) Arrays.fill(bytes, (byte) 0);
      if (credential.blob != null && credential.blobSize > 0 && credential.blobSize <= 2560)
        credential.blob.clear(credential.blobSize);
      api().CredFree(reference.getValue());
    }
  }

  private static Windows api() {
    return Holder.API;
  }

  private static final class Holder {
    static final Windows API = Native.load("Advapi32", Windows.class);
  }

  public interface Windows extends StdCallLibrary {
    boolean CredWriteW(Credential credential, int flags);

    boolean CredReadW(WString target, int type, int flags, PointerByReference result);

    boolean CredDeleteW(WString target, int type, int flags);

    void CredFree(Pointer pointer);
  }

  @Structure.FieldOrder({
    "flags",
    "type",
    "target",
    "comment",
    "writtenLow",
    "writtenHigh",
    "blobSize",
    "blob",
    "persist",
    "attributeCount",
    "attributes",
    "alias",
    "user"
  })
  public static class Credential extends Structure {
    public int flags, type;
    public WString target, comment;
    public int writtenLow, writtenHigh, blobSize;
    public Pointer blob;
    public int persist, attributeCount;
    public Pointer attributes;
    public WString alias, user;

    public Credential() {}

    public Credential(Pointer pointer) {
      super(pointer);
      read();
    }
  }
}
