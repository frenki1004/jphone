# jPhone launch plan

Assets: `jphone-promo.mp4` (19s, 1080p), `jphone-promo.gif`, `s1.png`–`s7.png`, `../img/hero.png`.

## Order

1. **jcode Discord + jcode GitHub Discussions** (day 1). Warmest audience, all jcode users. Ask the author (@1jehuang) if he'd mention it or link it from the jcode README as a community mobile client.
2. **X / Bluesky** (day 1). Post the MP4, tag @1jehuang and @Tailscale.
3. **Reddit** (days 2–4, one sub per day, native screenshots, no marketing tone): r/selfhosted, r/Tailscale, r/ClaudeAI, r/ChatGPTCoding, r/LocalLLaMA, r/commandline.
4. **Show HN** (Tue–Thu, 8–11am ET). Be around for 2–3 hours to answer comments.
5. **Directories** (any time, long tail): DevHunt, LibHunt, AlternativeTo, awesome-tailscale / awesome-selfhosted / awesome-ai-agents lists (open PRs).
6. **dev.to write-up**: "How I built a phone client for a coding agent with no build step".

## Drafts

### Show HN
Title: `Show HN: jPhone – Drive your jcode coding agent from your phone over Tailscale`

First comment:
> I run jcode (an open-source coding agent) on my Mac and kept wanting to check on or steer runs when I was away from my desk. jcode already ships a WebSocket gateway, but there was no client for it, so I built one as a plain web app: no build step, no app store, no third-party servers, one vendored library (jsQR).
>
> You pair with a 6-digit code (or QR), then get live streaming replies, terminal-style tool call rows, a per-reply "files changed" diff, stop/steer, sessions, photos and optional push. Traffic stays on your tailnet.
>
> The hard parts were surviving the phone sleeping and switching networks mid-run (it reattaches and replays the turn), and building a diff view from tool calls alone. Tests run on macOS's built-in JavaScriptCore, and an acceptance script drives a real gateway in headless WebKit.
>
> Happy to answer questions about the gateway protocol or the reconnect logic.

### X / Bluesky
> Your coding agent, in your pocket. 📱
>
> jPhone is an open-source phone client for @1jehuang's jcode: stream replies, watch tool calls, review diffs, stop or steer a run, from anywhere on your @Tailscale network.
>
> No app store. No build step. No servers.
> github.com/frenki1004/jphone
>
> [video]

### Reddit (r/selfhosted)
Title: `jPhone: a self-hosted phone UI for the jcode coding agent, Tailscale-only, no cloud`
> Small web app I built to control the jcode coding agent running on my Mac from my phone. It talks directly to jcode's built-in gateway, binds to your Tailscale IP, and has no backend of its own. Pair with a 6-digit code, then stream runs, stop or steer, review file diffs. Video + setup in the README: github.com/frenki1004/jphone. Feedback welcome, especially on the security model.

### jcode Discord
> Hey all, I built jPhone, a phone client for jcode's gateway: live streaming, tool calls, diffs, stop/steer, sessions, push. Works over Tailscale, no build step. 19s demo attached. github.com/frenki1004/jphone. Would love feedback from anyone using the gateway.
