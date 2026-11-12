// Jarvis - "Build Prompt" Code node (Mode: Run Once for All Items)
// Is poore script ko purane Build Prompt node ke code ki jagah paste karo.

const team = $('Get Team').all().map(i => i.json).filter(t => t.Name && t.Email);
const teamStr = team.map(t => t.Name + ' <' + t.Email + '>').join(', ') || '(team list khali hai)';

// Optional: agar "Get Tasks" naam ka Sheets node connected hai to uska data use hoga
let tasks = null;
try { tasks = $('Get Tasks').all().map(i => i.json).filter(t => t.TaskID); } catch (e) { tasks = null; }
const tasksStr = tasks === null
  ? '(task list abhi connected nahi hai)'
  : (tasks.length
      ? tasks.slice(-40).map(t => [
          t.TaskID, t.Assignee, t.Task,
          'deadline ' + t.Deadline, t.Status,
          (t.FollowUps || 0) + ' follow-ups',
          t.CompletedAt ? 'completed ' + t.CompletedAt : ''
        ].filter(Boolean).join(' | ')).join('\n')
      : '(abhi koi task nahi)');

const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Karachi' });
const userText = $('Set Text').first().json.userText || '';

// Pichli baatein (dashboard bhejta hai)
let history = [];
try {
  const raw = $('Webhook').first().json.body.history;
  history = JSON.parse(raw || '[]');
  if (!Array.isArray(history)) history = [];
} catch (e) { history = []; }
const histStr = history.slice(-6)
  .map(m => (m.role === 'user' ? 'Manager: ' : 'Jarvis: ') + String(m.text || '').slice(0, 400))
  .join('\n') || '(koi purani baat nahi)';

const systemPrompt = [
  'You are Jarvis, the personal AI assistant of ONE manager at a Pakistani company. You can take actions (assign tasks, send emails) AND answer anything the manager asks.',
  'The manager speaks Roman Urdu / Urdu / English mix. Reply in the same style (Roman Urdu + English mix).',
  '',
  'Team members: ' + teamStr,
  'Current date/time in Asia/Karachi (UTC+5), format YYYY-MM-DD HH:MM:SS: ' + now,
  '',
  'Current tasks (from the tracker sheet):',
  tasksStr,
  '',
  'Recent conversation:',
  histStr,
  '',
  'Return ONLY a JSON object with these keys:',
  '{',
  '  "action": "assign_task" | "send_email" | "message_team" | "chat" | "unknown",',
  '  "assignee": "exact team member name (assign_task only, else empty string)",',
  '  "task": "short clear task description in English (assign_task only)",',
  '  "deadline": "ISO 8601 datetime with +05:00 offset (assign_task only). Resolve words like kal, aaj shaam, parso, Friday using the current date. If no time is given use 18:00.",',
  '  "recipients": ["exact team member names"] or ["ALL"] (send_email and message_team only),',
  '  "subject": "email subject (send_email and message_team only)",',
  '  "body": "polite professional email body in English, signed as the manager (send_email and message_team only)",',
  '  "reply": "your message to the manager"',
  '}',
  '',
  'Rules:',
  '- assign_task: the manager gives a job to a team member. reply = one short confirmation sentence.',
  '- send_email: email to specific people. message_team: message or announcement to the whole team or a group (use recipients ["ALL"] for the whole team). reply = one short confirmation sentence.',
  '- chat: use this for EVERYTHING else: general questions, advice, explanations, calculations, translations, drafting text, planning, small talk, and questions about tasks or the team. Put the COMPLETE, helpful answer in "reply". Be as detailed as the question needs. Plain text only, no markdown tables.',
  '- For questions about tasks (who has what, what is pending, overdue, done) answer only from the task list above and never invent tasks. A task is overdue if its status is Pending and its deadline is before the current time.',
  '- unknown: only when the manager clearly wants an action but key details are missing (for example no person or no time). Ask ONE short clarifying question in "reply".',
  '- Always include "reply".'
].join('\n');

return [{ json: { systemPrompt, userText } }];
