package dev.leanreview.git;

import com.github.difflib.DiffUtils;
import java.util.*;

/** Unified patch format used by jsdiff createTwoFilesPatch, including newline markers. */
public final class TextPatch {
  private TextPatch() {}

  private record Line(char kind, String text) {}

  public static String create(String beforePath, String afterPath, String before, String after) {
    var original = lines(before);
    var modified = lines(after);
    var deltas = DiffUtils.diff(original, modified).getDeltas();
    var output = new ArrayList<Line>();
    int a = 0, b = 0;
    for (var delta : deltas) {
      while (a < delta.getSource().getPosition()) {
        output.add(new Line(' ', original.get(a++)));
        b++;
      }
      for (String line : delta.getSource().getLines()) {
        output.add(new Line('-', line));
        a++;
      }
      for (String line : delta.getTarget().getLines()) {
        output.add(new Line('+', line));
        b++;
      }
    }
    while (a < original.size()) output.add(new Line(' ', original.get(a++)));
    StringBuilder patch = new StringBuilder();
    if (beforePath.equals(afterPath)) patch.append("Index: ").append(beforePath).append('\n');
    patch
        .append("===================================================================\n--- ")
        .append(quotePath(beforePath))
        .append("\n+++ ")
        .append(quotePath(afterPath))
        .append('\n');
    int cursor = 0, oldLine = 1, newLine = 1;
    while (cursor < output.size()) {
      int first = cursor;
      while (first < output.size() && output.get(first).kind == ' ') first++;
      if (first == output.size()) break;
      int start = Math.max(cursor, first - 4);
      while (cursor < start) {
        if (output.get(cursor).kind != '+') oldLine++;
        if (output.get(cursor).kind != '-') newLine++;
        cursor++;
      }
      int last = first;
      for (int i = first + 1; i < output.size(); i++) {
        if (output.get(i).kind != ' ') {
          if (i - last > 9) break;
          last = i;
        }
      }
      int end = Math.min(output.size(), last + 5), oldCount = 0, newCount = 0;
      for (int i = start; i < end; i++) {
        if (output.get(i).kind != '+') oldCount++;
        if (output.get(i).kind != '-') newCount++;
      }
      patch
          .append("@@ -")
          .append(oldCount == 0 ? oldLine - 1 : oldLine)
          .append(',')
          .append(oldCount)
          .append(" +")
          .append(newCount == 0 ? newLine - 1 : newLine)
          .append(',')
          .append(newCount)
          .append(" @@\n");
      while (cursor < end) {
        Line line = output.get(cursor++);
        patch.append(line.kind).append(line.text);
        if (!line.text.endsWith("\n")) patch.append("\n\\ No newline at end of file\n");
        if (line.kind != '+') oldLine++;
        if (line.kind != '-') newLine++;
      }
    }
    return patch.toString();
  }

  private static List<String> lines(String text) {
    return text.isEmpty() ? List.of() : Arrays.asList(text.split("(?<=\n)"));
  }

  private static String quotePath(String path) {
    if (path.chars().allMatch(c -> c >= 32 && c <= 126 && c != '"' && c != '\\')) return path;
    StringBuilder quoted = new StringBuilder("\"");
    for (byte raw : path.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
      int value = raw & 255;
      quoted.append(
          switch (value) {
            case 7 -> "\\a";
            case 8 -> "\\b";
            case 9 -> "\\t";
            case 10 -> "\\n";
            case 11 -> "\\v";
            case 12 -> "\\f";
            case 13 -> "\\r";
            case 34 -> "\\\"";
            case 92 -> "\\\\";
            default ->
                value >= 32 && value <= 126
                    ? Character.toString((char) value)
                    : String.format("\\%03o", value);
          });
    }
    return quoted.append('"').toString();
  }
}
