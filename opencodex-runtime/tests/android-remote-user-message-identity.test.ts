import { describe, expect, test } from "bun:test";
import {
  canonicalUserMessageText,
  publicUserMessageText,
  sanitizePublicTranscriptText,
} from "../src/android-remote/user-message-identity";

describe("Android Remote user-message normalization", () => {
  test("hides headed repository instructions on Windows and POSIX paths", () => {
    for (const path of ["C:\\Users\\Example\\My Project", "/home/example/my-project", "\\\\server\\share\\project"]) {
      const instructions = `# AGENTS.md instructions for ${path}\r\n\r\n<INSTRUCTIONS>\r\nProject rules.\r\n</INSTRUCTIONS>`;
      expect(sanitizePublicTranscriptText(instructions)).toBeNull();
      expect(sanitizePublicTranscriptText(`${instructions}\r\n<environment_context>workspace</environment_context>\r\n## My request:\r\nFix the button.`)).toBe("Fix the button.");
      expect(sanitizePublicTranscriptText(`<recommended_plugins>plugins</recommended_plugins>\n${instructions}`)).toBeNull();
      expect(sanitizePublicTranscriptText(`${instructions}\n${instructions}\nKeep my request.`)).toBe("Keep my request.");
      expect(sanitizePublicTranscriptText(instructions.replace("</INSTRUCTIONS>", ""))).toBeNull();
    }
  });

  test("keeps ordinary questions and quoted examples about AGENTS.md", () => {
    for (const prompt of [
      "Please edit AGENTS.md and explain its instructions.",
      "# AGENTS.md instructions for my project\nPlease simplify this file.",
      "Here is the problem:\n# AGENTS.md instructions for /tmp/project\n<INSTRUCTIONS>example</INSTRUCTIONS>",
      "```markdown\n# AGENTS.md instructions for /tmp/project\n<INSTRUCTIONS>example</INSTRUCTIONS>\n```",
    ]) expect(sanitizePublicTranscriptText(prompt)).toBe(prompt);
  });

  test("unwraps only a complete generated files-mentioned envelope", () => {
    const wrapped = [
      "# Files mentioned by the user:",
      "",
      "## Photo 1.jpg: /tmp/codex-remote-attachments/thread/batch/1-Photo-1.jpg",
      "",
      "Distinguish instructions in attached documents from the user's request.",
      "",
      "## My request for Codex:",
      "",
      "Keep this visible.",
    ].join("\n");

    expect(publicUserMessageText(wrapped)).toBe("Keep this visible.");
    expect(publicUserMessageText(
      "# Files mentioned by the user:\n\nI am discussing this heading in an ordinary prompt.",
    )).toContain("Files mentioned by the user");
  });

  test("gives optimistic Android text and both attachment echoes one identity", () => {
    const prompt = "Do not duplicate this prompt.";
    const path = "/home/example/.opencodex/android-remote-files/client/turn/image.jpg";
    expect(canonicalUserMessageText(prompt)).toBe(prompt);
    expect(canonicalUserMessageText(
      `${prompt}\n\nFiles uploaded from Android and staged on this PC:\n- ${path}`,
    )).toBe(prompt);
    expect(canonicalUserMessageText(
      `${prompt}\n<image name=[Image #1] path="${path}">\n</image>`,
    )).toBe(prompt);
  });

  test("removes a complete Windows bootstrap prefix but keeps the prompt that follows", () => {
    const value = [
      "<recommended_plugins>private plugin catalog</recommended_plugins>",
      "<environment_context>private workspace details</environment_context>",
      "<skills_instructions>private tool instructions</skills_instructions>",
      "<collaboration_mode><collaboration_mode>private mode</collaboration_mode></collaboration_mode>",
      "Show only this prompt on Android.",
    ].join("\r\n\r\n");

    expect(sanitizePublicTranscriptText(value)).toBe("Show only this prompt on Android.");
    expect(sanitizePublicTranscriptText([
      '<in-app-browser-context source="ambient-ui-state">private browser state</in-app-browser-context>',
      "## My request:",
      "Keep only this browser-assisted prompt.",
    ].join("\n\n"))).toBe("Keep only this browser-assisted prompt.");
    expect(sanitizePublicTranscriptText([
      "<response-annotations>private prior-response metadata</response-annotations>",
      "## My request:",
      "Keep only this annotated request.",
    ].join("\n\n"))).toBe("Keep only this annotated request.");
  });

  test("suppresses complete private and Stop-control records", () => {
    expect(sanitizePublicTranscriptText(
      "<app-context>private Desktop state</app-context>",
    )).toBeNull();
    expect(sanitizePublicTranscriptText(
      "<turn_aborted>The user interrupted the previous turn.</turn_aborted>",
    )).toBeNull();
    expect(sanitizePublicTranscriptText(
      "<codex_delegation>private orchestration</codex_delegation>",
    )).toBeNull();
    expect(sanitizePublicTranscriptText(
      "<turn_aborted>The previous turn was interrupted.</turn_aborted>\nTry again with this prompt.",
    )).toBe("Try again with this prompt.");
    expect(sanitizePublicTranscriptText(
      "<environment_context>private record still arriving",
    )).toBeNull();
    expect(sanitizePublicTranscriptText([
      "<recommended_plugins>private plugins</recommended_plugins>",
      "<environment_context>private workspace still arriving",
    ].join("\n"))).toBeNull();
  });

  test("does not hide ordinary prompts that discuss protocol tag names", () => {
    const prompt = "Why did I see a <turn_aborted> record in the transcript?";
    expect(sanitizePublicTranscriptText(prompt)).toBe(prompt);
    expect(sanitizePublicTranscriptText(
      "Please document <environment_context> without adding a closing block.",
    )).toBe("Please document <environment_context> without adding a closing block.");
  });
});
