import type { APIRoute } from 'astro';
import { llmsSummary } from '../lib/llms';

export const GET: APIRoute = async () => new Response(await llmsSummary(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
