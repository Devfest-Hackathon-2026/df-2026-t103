import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveryQuestionnaireSummary } from "../app/(workspace)/deliveries/[deliveryId]/delivery-detail-client";

test("delivery detail summary renders complaint, selected locations, and free-text answers safely", () => {
  const fixture = {
    chiefComplaint: { value: "頭痛 <>& 主訴", source: "patient" },
    bodyLocations: ["left_knee", "throat"],
    sections: {
      associated_symptoms: {
        value: "咳 <>& 夜間に強くなる（合成自由回答）",
        source: "answer:synthetic-answer",
        answerState: "answered" as const,
      },
    },
    medicalHistorySnapshot: [],
    medicationSnapshots: [],
    unansweredTopics: [],
  };

  const html = renderToStaticMarkup(createElement(DeliveryQuestionnaireSummary, { snapshot: fixture }));

  assert.match(html, /主訴/);
  assert.match(html, /頭痛 &lt;&gt;&amp; 主訴/);
  assert.match(html, /症状の部位/);
  assert.match(html, /左膝、のど/);
  assert.match(html, /随伴症状/);
  assert.match(html, /咳 &lt;&gt;&amp; 夜間に強くなる（合成自由回答）/);
  assert.doesNotMatch(html, /<>&/);
});
