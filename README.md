# Jarvis Frontend (static, Vercel-ready)

Files: index.html, styles.css, app.js, config.js, vercel.json

## Setup
1. config.js mein N8N_BASE (apna n8n public https URL) aur SHEET_URL set karo.
2. Deploy: is folder mein `vercel --prod`  (ya GitHub push + Vercel import, Framework = Other, koi build command nahi).
3. Page kholo, PIN daalo (wahi PIN jo n8n ke "Check PIN" node mein hai).

## n8n endpoints jo UI use karti hai  (base: {N8N_BASE}/webhook/...)
- POST /jarvis  : multipart form: pin, text, audio  -> {ok, transcript, reply}      (BANA HUA - Main workflow)
- GET  /done?id=TASKID                                                              (BANA HUA - Done workflow)
- GET  /tasks?pin=PIN : Tasks sheet ki saari rows (array of objects)                (ABHI BANANA BAQI)
- GET  /team?pin=PIN  : Team sheet ki saari rows (array of {Name, Email})           (ABHI BANANA BAQI)

/tasks aur /team ke bagair Assistant tab poora chalta hai. Tasks/Team tab "Sample data" ya
tasks se derive kiye hue naam dikhate hain. Bad PIN par in endpoints ko {"ok":false,"error":"bad_pin"} bhejna chahiye.
