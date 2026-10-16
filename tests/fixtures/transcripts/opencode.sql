-- opencode 1.18's tables as `.schema` prints them, without the project foreign key.
CREATE TABLE `session` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `parent_id` text, `slug` text NOT NULL, `directory` text NOT NULL, `title` text NOT NULL, `version` text NOT NULL, `share_url` text, `permission` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_compacting` integer, `time_archived` integer, `agent` text, `model` text);
CREATE TABLE `message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL);
CREATE TABLE `part` (`id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL);
CREATE TABLE `permission` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `action` text NOT NULL, `resource` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL);

-- The pane's session, an older one for the same directory, and a subagent of the first.
INSERT INTO session VALUES ('ses_pane', 'prj_1', NULL, 'lab', '/srv/allowed/app', 'New session', '1.18.34', NULL, NULL, 1792078500000, 1792079474729, NULL, NULL, NULL, NULL);
INSERT INTO session VALUES ('ses_old', 'prj_1', NULL, 'lab-old', '/srv/allowed/app', 'Earlier session', '1.18.34', NULL, NULL, 1792000000000, 1792000100000, NULL, NULL, NULL, NULL);
INSERT INTO session VALUES ('ses_sub', 'prj_1', 'ses_pane', 'lab-sub', '/srv/allowed/app', 'Subagent', '1.18.34', NULL, NULL, 1792079480000, 1792079490000, NULL, NULL, NULL, NULL);

-- ses_old: one answered turn.
INSERT INTO message VALUES ('msg_old_u', 'ses_old', 1792000000000, 1792000000000, '{"role":"user","time":{"created":1792000000000},"agent":"build"}');
INSERT INTO part VALUES ('prt_old_u', 'msg_old_u', 'ses_old', 1792000000001, 1792000000001, '{"type":"text","text":"Say OLD."}');
INSERT INTO message VALUES ('msg_old_a', 'ses_old', 1792000000100, 1792000000100, '{"parentID":"msg_old_u","role":"assistant","mode":"build","agent":"build","time":{"created":1792000000100,"completed":1792000001000},"finish":"stop"}');
INSERT INTO part VALUES ('prt_old_a', 'msg_old_a', 'ses_old', 1792000000200, 1792000000200, '{"type":"text","text":"OLD","time":{"start":1792000000200,"end":1792000000300}}');

-- ses_pane turn 1: the question tool (G13), answered, then FRUIT=Pear.
INSERT INTO message VALUES ('msg_u1', 'ses_pane', 1792078850000, 1792078850000, '{"role":"user","time":{"created":1792078850000},"agent":"build","model":{"providerID":"openrouter","modelID":"z-ai/glm-5.3"}}');
INSERT INTO part VALUES ('prt_u1', 'msg_u1', 'ses_pane', 1792078850001, 1792078850001, '{"type":"text","text":"Ask me which fruit I prefer with the question tool: apple, pear or plum. Then reply FRUIT=<answer>."}');
INSERT INTO message VALUES ('msg_a1', 'ses_pane', 1792078851000, 1792078851000, '{"parentID":"msg_u1","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/srv/allowed/app","root":"/srv/allowed/app"},"time":{"created":1792078851000,"completed":1792078867500},"finish":"tool-calls"}');
INSERT INTO part VALUES ('prt_a1_q', 'msg_a1', 'ses_pane', 1792078856000, 1792078867469, '{"type":"tool","tool":"question","callID":"call_q1","state":{"status":"completed","input":{"questions":[{"header":"Fruit choice","question":"Which fruit?","options":[{"label":"Apple","description":"A crisp round fruit"},{"label":"Pear","description":"A sweet bell-shaped fruit"},{"label":"Plum","description":"A small stone fruit"}]}]},"output":"User has answered your questions: \"Which fruit?\"=\"Pear\". You can now continue with the user''s answers in mind.","metadata":{"answers":[["Pear"]],"truncated":false},"title":"Asked 1 question","time":{"start":1792078856496,"end":1792078867469}}}');
INSERT INTO part VALUES ('prt_a1_f', 'msg_a1', 'ses_pane', 1792078867500, 1792078867500, '{"type":"step-finish","reason":"tool-calls","snapshot":"e53f"}');
INSERT INTO message VALUES ('msg_a2', 'ses_pane', 1792078868000, 1792078868000, '{"parentID":"msg_u1","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/srv/allowed/app","root":"/srv/allowed/app"},"time":{"created":1792078868000,"completed":1792078870000},"finish":"stop"}');
INSERT INTO part VALUES ('prt_a2_t', 'msg_a2', 'ses_pane', 1792078869000, 1792078869000, '{"type":"text","text":"FRUIT=Pear","time":{"start":1792078869000,"end":1792078869500}}');

-- ses_pane turn 2: a bash call the owner rejected on the permission prompt (G14c). The model stopped.
INSERT INTO message VALUES ('msg_u2', 'ses_pane', 1792079437125, 1792079437125, '{"role":"user","time":{"created":1792079437125},"agent":"build"}');
INSERT INTO part VALUES ('prt_u2', 'msg_u2', 'ses_pane', 1792079437238, 1792079437238, '{"type":"text","text":"Run exactly this shell command: ls -la | head -3"}');
INSERT INTO message VALUES ('msg_a3', 'ses_pane', 1792079437245, 1792079437245, '{"parentID":"msg_u2","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/srv/allowed/app","root":"/srv/allowed/app"},"time":{"created":1792079437245,"completed":1792079474721},"finish":"tool-calls"}');
INSERT INTO part VALUES ('prt_a3_b', 'msg_a3', 'ses_pane', 1792079439063, 1792079474656, '{"type":"tool","tool":"bash","callID":"call_b1","state":{"status":"error","input":{"command":"ls -la | head -3"},"error":"The user rejected permission to use this specific tool call.","time":{"start":1792079439068,"end":1792079474656}}}');

-- The subagent's own answer must not be read as the pane's.
INSERT INTO message VALUES ('msg_sub_u', 'ses_sub', 1792079480000, 1792079480000, '{"role":"user","time":{"created":1792079480000},"agent":"explore"}');
INSERT INTO part VALUES ('prt_sub_u', 'msg_sub_u', 'ses_sub', 1792079480001, 1792079480001, '{"type":"text","text":"Find the config loader."}');
INSERT INTO message VALUES ('msg_sub_a', 'ses_sub', 1792079481000, 1792079481000, '{"parentID":"msg_sub_u","role":"assistant","mode":"explore","agent":"explore","time":{"created":1792079481000,"completed":1792079490000},"finish":"stop"}');
INSERT INTO part VALUES ('prt_sub_a', 'msg_sub_a', 'ses_sub', 1792079482000, 1792079482000, '{"type":"text","text":"SUBAGENT ANSWER"}');
