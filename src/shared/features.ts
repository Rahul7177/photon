import type { CustomizationsSnapshot } from "./types";

/**
 * Central feature toggle for Customizations (Settings -> Customizations tab,
 * Skills, Instructions/AGENTS.md, Custom Agents, and customization slash commands).
 *
 * Set to `true` in a future release to re-enable the full Customizations UI and runtime.
 */
export const CUSTOMIZATIONS_ENABLED = false;

export const EMPTY_CUSTOMIZATIONS_SNAPSHOT: CustomizationsSnapshot = {
  skills: [],
  instructions: [],
  agents: [],
  activeAgentId: null,
};
