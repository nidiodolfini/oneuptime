/*
 * Index MUST be imported before anything that reaches a tool module (see
 * EmbeddedImagesInPromptBuilders.test.ts): it is the production import order.
 */
import AIToolbox from "../../../../Server/Utils/AI/Toolbox/Index";
import IncidentAIContextBuilder, {
  AIGenerationContext,
  IncidentContextData,
  buildPostmortemLanguageRule,
} from "../../../../Server/Utils/AI/IncidentAIContextBuilder";
import IncidentEpisodeAIContextBuilder, {
  IncidentEpisodeContextData,
} from "../../../../Server/Utils/AI/IncidentEpisodeAIContextBuilder";
import { AiResponseLanguage } from "../../../../Server/EnvironmentConfig";
import Incident from "../../../../Models/DatabaseModels/Incident";
import IncidentEpisode from "../../../../Models/DatabaseModels/IncidentEpisode";
import ObjectID from "../../../../Types/ObjectID";
import { describe, expect, test } from "@jest/globals";

/*
 * Medgrupo: AI_RESPONSE_LANGUAGE in the postmortem prompts (incident and
 * episode, with and without a template). Without a template the whole
 * postmortem - headings included - is asked for in the language (nothing
 * parses a postmortem by its headings); with a template only the content is,
 * and the template's own headings stay exactly as the team wrote them. Unset,
 * the upstream prompts are untouched.
 */
const LANGUAGE: string = "Brazilian Portuguese (pt-BR)";
const TEMPLATE: string =
  "# Postmortem\n\n## 1. Resumo\n{resumo}\n\n## 2. Linha do tempo (BRT)\n| Horário | Evento |";
const WHOLE_DOCUMENT_RULE: string = `Write the entire postmortem, section headings included, in ${LANGUAGE}.`;
const CONTENT_ONLY_RULE: string = `- Write the content of every section in ${LANGUAGE}. Keep the template's headings, labels and table structure exactly as given.`;

function incidentContext(): IncidentContextData {
  const incident: Incident = new Incident(ObjectID.generate());
  incident.title = "Worker em CrashLoopBackOff";
  incident.description = "OOMKilled a cada 7 minutos.";

  return {
    incident,
    stateTimeline: [],
    internalNotes: [],
    publicNotes: [],
    workspaceMessages: [],
  };
}

function episodeContext(): IncidentEpisodeContextData {
  const episode: IncidentEpisode = new IncidentEpisode(ObjectID.generate());
  episode.title = "Fila de autorizações parada";

  return {
    episode,
    stateTimeline: [],
    internalNotes: [],
    memberIncidents: [],
    workspaceMessages: [],
  };
}

type Builder = (
  template: string | undefined,
  language: string,
) => AIGenerationContext;

// [name, builder, upstream's last CRITICAL INSTRUCTION of the template prompt]
const BUILDERS: Array<[string, Builder, string]> = [
  [
    "incident",
    (template: string | undefined, language: string): AIGenerationContext => {
      return IncidentAIContextBuilder.formatIncidentContextForPostmortem(
        incidentContext(),
        template,
        language,
      );
    },
    "- Write in a professional, clear, and concise manner",
  ],
  [
    "episode",
    (template: string | undefined, language: string): AIGenerationContext => {
      return IncidentEpisodeAIContextBuilder.formatEpisodeContextForPostmortem(
        episodeContext(),
        template,
        language,
      );
    },
    "- Consider all member incidents when analyzing root cause and impact",
  ],
];

describe("postmortem prompts — response language", () => {
  test("the toolbox loads first", () => {
    expect(AIToolbox).toBeDefined();
  });

  test.each(BUILDERS)(
    "%s: without a template the whole postmortem, headings included, is written in the language",
    (_name: string, build: Builder) => {
      const context: AIGenerationContext = build(undefined, ` ${LANGUAGE} `);

      expect(context.systemPrompt).toContain(WHOLE_DOCUMENT_RULE);
      expect(context.systemPrompt).not.toContain(
        "Write the content of every section",
      );
      // The rule closes the grounding rules; the user message is upstream's.
      expect(context.systemPrompt.trimEnd().endsWith("unchanged.")).toBe(true);
      expect(context.messages[0]?.content).toBe(context.systemPrompt);
      expect(context.messages[1]?.content).not.toContain(LANGUAGE);
    },
  );

  test.each(BUILDERS)(
    "%s: with a template only the content is written in the language and the template's headings stay",
    (_name: string, build: Builder, lastUpstreamInstruction: string) => {
      const context: AIGenerationContext = build(TEMPLATE, LANGUAGE);

      // The rule follows upstream's last instruction as one more bullet.
      expect(context.systemPrompt).toContain(
        `${lastUpstreamInstruction}\n${CONTENT_ONLY_RULE}`,
      );
      expect(context.systemPrompt).not.toContain("Write the entire postmortem");
      expect(context.systemPrompt).toContain(TEMPLATE);
      // The rule is one of the CRITICAL INSTRUCTIONS, ahead of the template.
      expect(context.systemPrompt.indexOf(CONTENT_ONLY_RULE)).toBeLessThan(
        context.systemPrompt.indexOf("TEMPLATE TO FILL"),
      );
    },
  );

  test.each(BUILDERS)(
    "%s: adds nothing when no language is set",
    (_name: string, build: Builder, lastUpstreamInstruction: string) => {
      const plain: AIGenerationContext = build(undefined, "");
      const templated: AIGenerationContext = build(TEMPLATE, "   ");

      expect(plain.systemPrompt).not.toContain("Write the entire postmortem");
      expect(
        plain.systemPrompt
          .trimEnd()
          .endsWith("Never fabricate numbers or state confidence levels."),
      ).toBe(true);
      expect(templated.systemPrompt).not.toContain(
        "Write the content of every section",
      );
      expect(templated.systemPrompt).toContain(
        `${lastUpstreamInstruction}\n\nTEMPLATE TO FILL`,
      );
    },
  );

  test("the default language is AI_RESPONSE_LANGUAGE", () => {
    const context: AIGenerationContext =
      IncidentAIContextBuilder.formatIncidentContextForPostmortem(
        incidentContext(),
      );

    expect(context.systemPrompt).toContain(
      buildPostmortemLanguageRule({
        language: AiResponseLanguage,
        hasTemplate: false,
      }),
    );
    if (!AiResponseLanguage) {
      expect(context.systemPrompt).not.toContain(
        "Write the entire postmortem",
      );
    }
  });
});
