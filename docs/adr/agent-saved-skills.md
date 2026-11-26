# Agents save skills for the person to check

Decision date: 26 November 2026 (founder).

The founder wrote a skill with ChatGPT and asked it to save the skill to Warthog. ChatGPT replied
that the Warthog connector "only exposes the ability to read existing skills, not create or publish
new ones", and offered a SKILL.md to import by hand. The founder asked for Warthog to accept skills
that ChatGPT, Claude, Gemini and other agents create, saved straight into Warthog.

A skill tells every agent that gets it what to do, and agents treat it as the person's own
instructions. An agent that saves one could have been steered by an email someone else wrote, so
an agent-written skill reaching other agents unchecked would let one bad email instruct all of
them. The founder chose (AskUserQuestion, 26 November):

- **New skills:** off until the person turns them on.
- **Revisions:** changes wait for the person.
- **Who can save:** every agent, with a switch per agent.

## Decision

1. **A new core tool, `save_skill`.** The agent sends either the whole SKILL.md (`skill_md`:
   frontmatter with name and description, then the instructions) or its three parts (`name`,
   `description`, `instructions`), plus optional supporting `files`. Warthog saves it as a library
   package, the same as a SKILL.md the person imports (`src/server/skills/agent-skills.ts`). The
   package keeps the SKILL.md as written, unknown frontmatter included, so it downloads unchanged.
2. **It's saved switched off.** No agent gets it, the saving agent included, until the person turns
   it on on the Skills page. The package records which agent saved it, and that it's waiting for
   the person (migration 0128: `skill_packages.saved_by_agent_id`, `awaiting_check`). The tool's
   reply tells the agent to say so, with the Skills page address.
3. **The saving agent may replace its draft until the person checks it.** "Checks" means: the
   person turns it on, changes who gets it, or saves the package themselves. Before that, the
   saving agent's revision (`save_skill` with the skill's `id`) replaces the draft. It still reaches
   no one.
4. **After that, a revision waits beside the skill.** This covers a skill the person has checked, a
   skill the person wrote, and one an agent saved that the person has since edited. The agent's
   SKILL.md is kept as a suggestion in `skill_suggestions` (one per skill; a newer one replaces it),
   as a `v1:` envelope under the person's data key. The skill as it is keeps working. The person
   sees "ChatGPT suggests changes to …" under **Waiting for you** at the top of the Skills library,
   with the change shown line by line, and chooses:
   - **Use these changes:** the skill takes the suggested wording. It keeps its id, whether it's on,
     who gets it, and agents' choices about it.
   - **Keep mine:** the suggestion is removed.

   A suggestion carries only the SKILL.md. Changing a checked skill's supporting files is the
   person's job, done by importing the new version. The line-by-line view
   (`src/domain/skills/line-diff.ts`) makes one slipped-in instruction show as one added line.
5. **What an agent can revise.** An agent can revise only a skill it can use now (on, and given to
   it), or one it saved itself. Any other id, including another agent's draft or another person's
   skill, is "No skill with that id is available to you". Warthog's own skills have no id an agent
   can send; they are changed on the Skills page.
6. **The same checks as an import, plus Warthog's never-kept rules.**
   - Warthog's skill titles can't be taken.
   - A name already in the library is refused; the reply says to pass the skill's id instead.
   - The package limits still apply: 100 files, 200 KB a file, 1 MB in all.
   - A skill holding a password, tax file number, BSB and account number, payment details or a
     government ID number is refused, as a memory would be. Card numbers are masked to their last
     four.
   - Each agent may have at most 20 saves waiting for the person.
   - A suggestion for a skill written on the Skills page keeps that page's limit of 20,000
     characters of instructions.
7. **Every agent can save, unless the person says no.** "Let it save skills" sits in the Skills
   section of each agent's permissions, on unless turned off
   (`agent_permissions.resource_controls.skillsWrite`; no migration needed). That includes agents
   already connected. `get_context` reports it as `permissions.resources.skills.write`. With it
   off, `save_skill` is refused and names the switch. The risk is low because nothing an agent saves
   reaches another agent until the person acts.
8. **Recorded like any change.** `save_skill` runs through the agent-call pipeline like the other
   core change tools, which records each call as Warthog's own activity entry ("Save a skill").

## Not done

- **Notice elsewhere:** Home and the Skills nav item don't show a count of what's waiting. The
  agent's reply tells it to point the person to the Skills page.
- **Export:** suggestions aren't exported. They are pending agent data, like About you suggestions.
  An exported agent-saved package is restored as the person's own, still switched off.
- **House skill:** "Using Warthog" doesn't mention `save_skill`. Its guidance is versioned, and the
  tool's own description is enough for agents to find it.
