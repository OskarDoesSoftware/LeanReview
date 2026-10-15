package dev.leanreview.api;

import java.awt.Desktop;
import java.net.URI;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class LocalLauncher {
  private final LocalAccess access;
  private final boolean openBrowser;

  public LocalLauncher(
      LocalAccess access, @Value("${leanreview.open-browser:false}") boolean openBrowser) {
    this.access = access;
    this.openBrowser = openBrowser;
  }

  @EventListener
  public void ready(ApplicationReadyEvent event) {
    if (!(event.getApplicationContext() instanceof WebServerApplicationContext)) return;
    String link = access.startupLink();
    if (openBrowser && !"1".equals(System.getenv("LEANREVIEW_NO_OPEN"))) {
      try {
        if (Desktop.isDesktopSupported()
            && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
          Desktop.getDesktop().browse(URI.create(link));
          return;
        }
      } catch (Exception unavailable) {
        /* Display the one-time link when desktop opening is unavailable. */
      }
    }
    // Intentional startup display, matching Node; never include the nonce in access/error logs.
    System.out.println("Startup link: " + link);
  }
}
