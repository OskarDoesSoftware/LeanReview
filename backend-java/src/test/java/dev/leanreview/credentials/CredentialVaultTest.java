package dev.leanreview.credentials;

import static org.assertj.core.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class CredentialVaultTest {
  @Test
  void sessionMemoryAndUnavailablePersistentStorageNeverFallBackSilently() {
    var persistent =
        new CredentialVault.Persistent() {
          public void set(String key, String token) {
            throw new IllegalStateException("private diagnostic");
          }

          public String get(String key) {
            throw new IllegalStateException("private diagnostic");
          }
        };
    var vault = new CredentialVault(persistent);
    vault.set("key", "session-fixture-token", false);
    assertThat(vault.get("key", false)).isEqualTo("session-fixture-token");
    assertThatThrownBy(() -> vault.set("key", "new-fixture-token", true))
        .hasMessage(
            "OS credential storage is unavailable or locked. Select session-only storage"
                + " explicitly.");
    assertThat(vault.get("key", true)).isEqualTo("session-fixture-token");
    assertThat(new CredentialVault(persistent).get("key", true)).isNull();
    assertThat(new CredentialVault(persistent).get("key", false)).isNull();
  }

  @Test
  void windowsCredentialsRoundTripWithTheExistingNodeBinding() throws Exception {
    org.junit.jupiter.api.Assumptions.assumeTrue(
        System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win"));
    String account = "leanreview-migration-test-" + UUID.randomUUID();
    String token = "fixture-secret-café-123";
    var nativeStore = new NativeCredentials();
    try {
      node(account, token, "set");
      var windows = com.sun.jna.Native.load("Advapi32", NativeCredentials.Windows.class);
      var reference = new com.sun.jna.ptr.PointerByReference();
      assertThat(
              windows.CredReadW(new com.sun.jna.WString(account + ".LeanReview"), 1, 0, reference))
          .isTrue();
      try {
        assertThat(new NativeCredentials.Credential(reference.getValue()).persist).isEqualTo(3);
      } finally {
        windows.CredFree(reference.getValue());
      }
      assertThat(nativeStore.get(account)).isEqualTo(token);
      nativeStore.set(account, token + "-java");
      node(account, token + "-java", "check");
      assertThat(new NativeCredentials().get(account)).isEqualTo(token + "-java");
    } finally {
      com.sun.jna.Native.load("Advapi32", NativeCredentials.Windows.class)
          .CredDeleteW(new com.sun.jna.WString(account + ".LeanReview"), 1, 0);
    }
    assertThat(nativeStore.get(account)).isNull();
  }

  @org.junit.jupiter.api.condition.EnabledOnOs({
    org.junit.jupiter.api.condition.OS.MAC,
    org.junit.jupiter.api.condition.OS.LINUX
  })
  @org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable(
      named = "LEANREVIEW_KEYRING_ACCEPTANCE",
      matches = "1")
  @Test
  void unixCredentialsRoundTripWithTheExistingNodeBinding() throws Exception {
    String account = "leanreview-platform-test-" + UUID.randomUUID();
    String token = "synthetic-platform-credential";
    var nativeStore = new NativeCredentials();
    try {
      String fixtureKeychain = System.getenv("LEANREVIEW_TEST_KEYCHAIN");
      if (fixtureKeychain != null
          && System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("mac")) {
        // Only the disposable CI credential grants access to these fixture executables.
        Process permission = new ProcessBuilder(
            "/usr/bin/security", "add-generic-password", "-a", account, "-s", "LeanReview",
            "-w", token, "-T", "/usr/bin/security", "-T",
            ProcessHandle.current().info().command().orElseThrow(), "-T",
            Path.of(System.getenv("LEANREVIEW_TEST_NODE")).toRealPath().toString(), fixtureKeychain)
            .redirectErrorStream(true).start();
        assertThat(permission.waitFor(10, TimeUnit.SECONDS)).isTrue();
        assertThat(permission.exitValue()).isZero();
      }
      node(account, token, "set");
      assertThat(nativeStore.get(account)).isEqualTo(token);
      nativeStore.set(account, token + "-java");
      node(account, token + "-java", "check");
    } catch (Exception | AssertionError failure) {
      try {
        node(account, token, "delete");
      } catch (Exception | AssertionError cleanup) {
        failure.addSuppressed(cleanup);
      }
      throw failure;
    } finally {
      if (System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("linux")) {
        try (var collection = new com.github.javakeyring.internal.freedesktop.SimpleCollection()) {
          for (String item :
              collection.getItems(Map.of("service", "LeanReview", "username", account)))
            collection.deleteItem(item);
        }
      }
      var type =
          System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("mac")
              ? com.github.javakeyring.KeyringStorageType.OSX_KEYCHAIN
              : com.github.javakeyring.KeyringStorageType.GNOME_KEYRING;
      try (var store = com.github.javakeyring.Keyring.create(type)) {
        try {
          store.deletePassword("LeanReview", account);
        } catch (com.github.javakeyring.PasswordAccessException absent) {
          /* Node cleanup may already have removed it. */
        }
      }
    }
  }

  private void node(String account, String token, String action) throws Exception {
    String script =
        "import {Entry} from '@napi-rs/keyring'; import fs from 'node:fs'; const"
            + " x=JSON.parse(fs.readFileSync(0,'utf8'));const e=new"
            + " Entry('LeanReview',x.account);if(x.action==='set')e.setPassword(x.token);else"
            + " if(x.action==='delete')e.deletePassword();else"
            + " if(e.getPassword()!==x.token)process.exit(2);console.log('ok');";
    Process process =
        new ProcessBuilder("node", "--input-type=module", "-e", script)
            .directory(Path.of("..").toFile())
            .redirectErrorStream(true)
            .start();
    try (var stream = process.getOutputStream()) {
      stream.write(
          new com.fasterxml.jackson.databind.ObjectMapper()
              .writeValueAsBytes(Map.of("account", account, "token", token, "action", action)));
    }
    assertThat(process.waitFor(20, TimeUnit.SECONDS)).isTrue();
    assertThat(process.exitValue()).as("Node credential fixture exit code").isZero();
    assertThat(new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim())
        .isEqualTo("ok");
  }
}
