// Demo transcript for screenshots and trying the UI without a Mac: open ?demo
// Event shapes mirror what jcode's gateway really sends (see spike/fixtures).

export const DEMO_SESSION = "session_otter_1793479403131_e967f8337fc89634";

export function demoHistory() {
  return {
    type: "history",
    session_id: DEMO_SESSION,
    server_name: "studio",
    server_icon: "🖥️",
    server_version: "v0.99.1",
    provider_name: "Claude",
    provider_model: "claude-opus-5-5",
    available_models: ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "gpt-5.6-sol", "gemini-3-pro"],
    all_sessions: [DEMO_SESSION, "session_rhino_1793478612553_1912ddc38a91c030", "session_skunk_1793479389272_810c41952f0a7eae"],
    messages: [
      { role: "user", content: "The booking form double-submits on slow networks. Can you fix it?" },
      { role: "assistant", content: "Let me find the submit handler." },
      {
        role: "tool",
        content: 'src/components/BookingForm.tsx:42:  const onSubmit = async (data) => {\nsrc/components/BookingForm.tsx:58:      <button type="submit">Book</button>',
        tool_data: { id: "t1", name: "agentgrep", input: { query: "onSubmit", intent: "Find submit handler" } },
      },
      {
        role: "tool",
        content: "  40  export function BookingForm() {\n  41    const [saving, setSaving] = useState(false)\n  42    const onSubmit = async (data) => {",
        tool_data: { id: "t2", name: "read", input: { file_path: "src/components/BookingForm.tsx", intent: "Read the form" } },
      },
      {
        role: "tool",
        content: "Success. Updated 1 file.",
        tool_data: {
          id: "t3",
          name: "apply_patch",
          input: {
            patch_text:
              "*** Begin Patch\n*** Update File: src/components/BookingForm.tsx\n@@ export function BookingForm() {\n   const [saving, setSaving] = useState(false)\n-  const onSubmit = async (data) => {\n-    await api.book(data)\n+  const onSubmit = async (data: Booking) => {\n+    if (saving) return // ignore double taps\n+    setSaving(true)\n+    try {\n+      await api.book(data)\n+    } finally {\n+      setSaving(false)\n+    }\n   }\n@@\n-      <button type=\"submit\">Book</button>\n+      <button type=\"submit\" disabled={saving}>Book</button>\n*** Add File: src/components/BookingForm.test.tsx\n+it(\"ignores a double submit\", async () => {\n+  render(<BookingForm />)\n+  await user.dblClick(screen.getByText(\"Book\"))\n+  expect(api.book).toHaveBeenCalledTimes(1)\n+})\n*** End Patch\n",
            intent: "Guard against double submit",
          },
        },
      },
      { role: "tool", content: " ✓ 24 tests passed (1.8s)", tool_data: { id: "t4", name: "bash", input: { command: "npm test -- BookingForm", intent: "Run form tests" } } },
      {
        role: "assistant",
        content:
          "Fixed. The button now disables while the request is in flight, and `onSubmit` returns early if a submit is already running:\n\n```tsx\nconst onSubmit = async (data: Booking) => {\n  if (saving) return; // ignore double taps\n  setSaving(true);\n  try {\n    await api.book(data);\n  } finally {\n    setSaving(false);\n  }\n};\n```\n\n- **Root cause:** nothing stopped a second tap while the first request was pending\n- **Tests:** all 24 pass, including a new `double submit` case",
        response_stats: { input_tokens: 18420, output_tokens: 612 },
      },
    ],
  };
}

// A turn in progress: user asks, jcode answers and is mid-tool.
export function demoLive(dispatch) {
  dispatch({ type: "local:user", text: "Nice. Now deploy it to staging", requestId: 42 });
  dispatch({ type: "text_delta", text: "Building and pushing to staging." });
  dispatch({ type: "tool_start", id: "l1", name: "bash" });
  dispatch({ type: "tool_input", id: "l1", delta: '{"command":"npm run build && ./scripts/deploy.sh staging","intent":"Deploy to staging"}' });
  dispatch({ type: "tool_exec", id: "l1", name: "bash" });
}
