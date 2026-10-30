import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'launch_client_project',
    {
      title: 'Launch a client project',
      description: "Walks through a client's launch: create, fill, preview, confirm, launch.",
      argsSchema: z.object({
        url: z.string().describe("The client product's URL"),
        contact_email: z.string().optional().describe('Email the directories should write to'),
      }),
    },
    ({ url, contact_email }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Launch directory submissions for ${url}.`,
              '1. Call whoami and tell me the mode and the launches left.',
              `2. Create the project${contact_email ? ` with contact_email ${contact_email}` : ''}; then read it back with get_project.`,
              '3. Fill what preview_launch lists as missing. Use image_candidates for the logo and screenshots when they fit; ask me when unsure.',
              '4. Show me the preview: how many directories, top and median DR, what would unlock more, the contact email and the cost.',
              '5. Launch only after I say yes, with the same arguments and confirm_selected from the preview. Then tell me how to follow the progress.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'client_progress_update',
    {
      title: 'Progress update for a client',
      description: "Drafts a short progress note for the agency's client, without naming Submitator.",
      argsSchema: z.object({ project_id: z.string().describe('Project id, prj_...') }),
    },
    ({ project_id }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Write a short progress update for the client of project ${project_id}.`,
              'Read get_project for the counts, then list_listings with status live and limit 50, following next_cursor until has_more is false, for the published links.',
              'Write it in our agency voice: never name Submitator or any tool we use. List the live links with their directory names, say how many are still in progress, and mention anything waiting on the client (action.waiting_on = client) as a clear request.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
