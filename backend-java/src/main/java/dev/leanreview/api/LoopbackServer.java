package dev.leanreview.api;

import java.net.InetAddress;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Local review data must never bind to a public interface, including through overrides. */
@Configuration
public class LoopbackServer {
  @Bean
  WebServerFactoryCustomizer<TomcatServletWebServerFactory> localOnly() {
    return factory -> {
      factory.setAddress(InetAddress.getLoopbackAddress());
      factory.addConnectorCustomizers(
          connector -> {
            connector.setProperty("maxThreads", "24");
            connector.setProperty("maxConnections", "64");
            connector.setProperty("acceptCount", "32");
          });
    };
  }
}
