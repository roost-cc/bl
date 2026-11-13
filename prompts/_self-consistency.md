## Self-consistent designs

Before adding a constant, list, table, type, helper or format, find where the system already
defines that concept. Sources of truth (config, schema, registry) win: derive from them and
extend them if they fall short, rather than restating them beside them. A story's words state
intent, not mechanism: if it names values the system already defines, use the definition. A new
source of truth needs a stated reason. A change should read as if the system had always had it.

Code depends on function, never on a point in time. An acceptance criterion states what the
code does, as a test or a command and its expected output. It never asks for identity with a
commit, a file snapshot or a hash ("byte-identical to `8c1a254`"): a review fix then breaks the
criterion though the behaviour is right. When the same change sits on two branches, name the
step that drops one copy, and do not make the copies identical.
