# English Evaluator — AI Speaking Assessment

Node.js / Express web app that records or uploads a spoken answer and returns a CEFR-style English level.

- **Azure Speech (Pronunciation Assessment)** for pronunciation, fluency, accuracy and completeness scores
- **Groq LLM** for grammar and vocabulary feedback on the transcript
- **ffmpeg** audio conversion (browser recordings → WAV) via `fluent-ffmpeg`
- Browser front end in `public/` (record, upload, results)

## Run locally
```bash
npm install
cp .env.example .env   # add your Azure Speech + Groq keys
npm start              # http://localhost:3000
```
