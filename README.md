# VoiceFlow

A small, dependency-free voice transcription and cleanup app for AI Builder Space.

## Run

Requires Node.js 24 or newer.

```sh
AI_BUILDER_TOKEN=your_server_token PORT=8000 npm start
```

Set the environment variable in your server runtime. AI Builder Space injects `AI_BUILDER_TOKEN` when deploying. Open `http://localhost:8000` locally. Microphone recording requires HTTPS or localhost and browser permission.

```sh
npm test
```

## Behavior

- Audio is sent to the existing AI Builder Space `/v1/audio/transcriptions` endpoint with recognition terms supplied by the visitor. Cleanup uses `deepseek-v4-flash`, the platform compatibility ID for DeepSeek V4.1 Flash.
- `skills/cleanup.md` preserves intake's pause-word, name/terminology, spacing, voice and complete-transcript rules. Person-specific examples and local file-writing instructions are omitted from this public template.
- Each visitor fills in their own name and terminology list in settings. There is no bundled name list.
- Audio and text are processed in server memory. The server does not write them to disk. AI Builder Space processes the audio and text under its own service policies.
- Local saving is off by default. When enabled, the browser saves the visitor's list and, on a successful Copy action, the raw transcription, original model output and edited result. Records are kept in IndexedDB on that device. The list is kept in localStorage. Saving the same edit of the same result again updates its record. Turning saving off clears saved records and the saved list. The current page's in-memory result remains editable.
- Saved pairs survive browser refreshes. They are not synced between devices. Browser data removal also removes the saved records. Recent pairs are visible below the editor.
- Recordings are limited to two minutes in the browser, and uploads to 20 MB. Processing time depends on audio duration and upstream response time. Requests time out with a retry message.
- The public service uses in-memory request limits and a small concurrency cap. Server logs contain startup messages, not audio, names, text, or credentials.

## Deploy to AI Builder Space

The Dockerfile runs one Node server on the runtime `PORT` (default 8000). Static files and API routes share that server. Publish this source-only project to a public Git repository, then deploy that repository with the platform deployment API. The injected token belongs in the server environment, never in the repository or browser code. Any local environment files, recordings, personal lists, evaluation corpora and operational logs are excluded from the project.

Set `PUBLIC_ORIGIN` to the deployed HTTPS origin, such as `https://voiceflow.ai-builders.space`, without a path. This keeps browser uploads working when the reverse proxy rewrites the internal Host header, while rejecting requests from other origins. Leave it unset for direct localhost use.

Repository publication and deployment should happen only after its owner has reviewed the complete file list.
