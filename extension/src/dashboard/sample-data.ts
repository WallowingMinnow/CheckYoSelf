// A FICTIONAL sample report, so the dashboard has something to show before
// you check your own posts. The person, university, café, dorm and handle are
// all made up. The results are written by hand in the same format the backend
// returns (AnalyzeResponse); they were NOT produced by the AI. The dashboard
// labels them "Sample report".
//
// A test (test/dashboard-report.test.ts) checks that every verified quote
// below really appears in the text it points to.
import { CONTRACT_VERSION, type AnalyzeResponse, type Finding } from "../../../shared/contract";
import type { AnalyzedPost } from "./report";

function sampleResult(
  postId: string,
  analyzedAt: string,
  summary: string,
  findings: Finding[],
  historyUsed: AnalyzeResponse["historyUsed"] = [],
): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: `sample-${postId}`,
    draftHash: `sample-${postId}`,
    mode: "mock",
    model: null,
    promptVersion: null,
    analyzedAt,
    summary,
    findings,
    droppedFindings: 0,
    historyUsed,
  };
}

const MOVE_IN_CAPTION =
  "Move-in day done! Room 214 in Harlow Hall is tiny but it's home 🏠 Lakeshore State University, here I come 🎓";
const STUDY_CAPTION =
  "My second home ☕ Bean There Café on Orchard Ave has the best oat lattes. " +
  "Find me at the window table most mornings! Study group? DM @lena.studies";
const COMMUTE_CAPTION = "Same 7:40 bus from Orchard Ave every weekday so I make my 8am lab 😴 #routine";
const WEEKEND_CAPTION =
  "Flying home Friday through Sunday to be with Mom after her surgery ✈️ " +
  "Harlow Hall is going to be so quiet this weekend";

export const SAMPLE_POSTS: AnalyzedPost[] = [
  {
    id: "post-1",
    title: "Move-in day",
    date: "2026-09-02T18:20:00Z",
    historyPostId: "p-move-in",
    tone: "blue",
    sources: [
      { id: "caption", type: "caption", text: MOVE_IN_CAPTION },
      { id: "image_text:1", type: "image_text", text: "LAKESHORE STATE UNIVERSITY · CLASS OF 2030" },
    ],
    result: sampleResult(
      "post-1",
      "2026-09-02T18:21:00Z",
      "This post names your university and gives your exact room and building.",
      [
        {
          id: "f1",
          category: "location",
          severity: "high",
          exposure: "Your room number and residence hall together point to exactly where you sleep.",
          evidence: [{ sourceId: "caption", quote: "Room 214 in Harlow Hall", verified: true }],
          crossSource: false,
          confidence: "high",
          uncertainty: "Assumes you still live there; room assignments change each year.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "generalize",
              original: "Room 214 in Harlow Hall",
              replacement: "My new room",
              explanation: "Keeps the moment without the address.",
            },
          ],
        },
        {
          id: "f2",
          category: "workplace_school",
          severity: "medium",
          exposure: "Names your university in both the caption and the photo, so anyone can narrow down where you spend your days.",
          evidence: [
            { sourceId: "caption", quote: "Lakeshore State University", verified: true },
            { sourceId: "image_text:1", quote: "LAKESHORE STATE UNIVERSITY", verified: true },
          ],
          crossSource: true,
          confidence: "high",
          uncertainty: "Thousands of students go there, so on its own this only narrows things to a large campus.",
          suggestedEdits: [
            {
              sourceId: "image_text:1",
              action: "crop_or_blur_image",
              explanation: "Crop out the banner with the university name.",
            },
          ],
        },
      ],
    ),
  },
  {
    id: "post-2",
    title: "Study spot",
    date: "2026-09-20T15:05:00Z",
    historyPostId: "p-study-spot",
    tone: "violet",
    sources: [
      { id: "caption", type: "caption", text: STUDY_CAPTION },
      { id: "image_text:1", type: "image_text", text: "BEAN THERE CAFÉ · OPEN 6AM" },
    ],
    result: sampleResult(
      "post-2",
      "2026-09-20T15:06:00Z",
      "This post shows a café you visit often, when you're usually there, and how to message you.",
      [
        {
          id: "f1",
          category: "location",
          severity: "medium",
          exposure: "Names a café you visit often, and the street it's on.",
          evidence: [
            { sourceId: "caption", quote: "Bean There Café on Orchard Ave", verified: true },
            { sourceId: "image_text:1", quote: "BEAN THERE CAFÉ", verified: true },
          ],
          crossSource: true,
          confidence: "high",
          uncertainty: "A café is a busy public place; the risk grows when it's combined with times.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "generalize",
              original: "Bean There Café on Orchard Ave",
              replacement: "my favorite café",
              explanation: "Same feeling, no street name.",
            },
          ],
        },
        {
          id: "f2",
          category: "routine_schedule",
          severity: "medium",
          exposure: "Says you sit at the same table most mornings.",
          evidence: [{ sourceId: "caption", quote: "window table most mornings", verified: true }],
          crossSource: false,
          confidence: "medium",
          uncertainty: "\"Most mornings\" may be loose wording rather than a fixed habit.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "generalize",
              original: "Find me at the window table most mornings!",
              replacement: "Great place to study!",
              explanation: "Doesn't tell people when to find you.",
            },
          ],
        },
        {
          id: "f3",
          category: "contact",
          severity: "low",
          exposure: "Shares your handle and invites strangers to message you.",
          evidence: [{ sourceId: "caption", quote: "DM @lena.studies", verified: true }],
          crossSource: false,
          confidence: "high",
          uncertainty: "Public handles are common; the risk depends on what that account shows.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "remove",
              original: "Study group? DM @lena.studies",
              explanation: "Share it with classmates directly instead.",
            },
          ],
        },
      ],
    ),
  },
  {
    id: "post-3",
    title: "Morning commute",
    date: "2026-10-08T12:45:00Z",
    historyPostId: "p-commute",
    tone: "teal",
    sources: [
      { id: "caption", type: "caption", text: COMMUTE_CAPTION },
      { id: "image_text:1", type: "image_text", text: "ROUTE 12 · CAMPUS LOOP" },
    ],
    result: sampleResult(
      "post-3",
      "2026-10-08T12:46:00Z",
      "This post gives a fixed weekday time and place. Combined with two earlier posts, it shows a predictable morning routine.",
      [
        {
          id: "f1",
          category: "routine_schedule",
          severity: "high",
          exposure: "Gives the exact time and street where you catch the bus every weekday.",
          evidence: [
            { sourceId: "caption", quote: "7:40 bus from Orchard Ave every weekday", verified: true },
            { sourceId: "image_text:1", quote: "ROUTE 12", verified: true },
          ],
          crossSource: true,
          confidence: "high",
          uncertainty: "Bus schedules and classes change each semester.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "generalize",
              original: "Same 7:40 bus from Orchard Ave every weekday",
              replacement: "Early bus again",
              explanation: "Drops the time and the stop.",
            },
          ],
        },
        {
          id: "f2",
          category: "routine_schedule",
          severity: "high",
          exposure:
            "Together, these posts outline a predictable weekday routine: you leave from Orchard Ave around 7:40, " +
            "spend mornings at Bean There Café on the same street, and study at Lakeshore State University. " +
            "Someone could anticipate where you'll be and when.",
          evidence: [
            { sourceId: "caption", quote: "7:40 bus from Orchard Ave every weekday", verified: true },
            { sourceId: "history:p-study-spot", quote: "Bean There Café on Orchard Ave", verified: true },
            { sourceId: "history:p-study-spot", quote: "window table most mornings", verified: true },
            { sourceId: "history:p-move-in", quote: "Lakeshore State University", verified: true },
          ],
          crossSource: true,
          confidence: "medium",
          uncertainty: "This assumes the earlier posts are still accurate. Routines and favorite places change.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "other",
              explanation: "Hide the café post or remove its street name, so this pattern can't be pieced together.",
            },
          ],
        },
      ],
      [
        { sourceId: "history:p-move-in", postId: "p-move-in", publishedAt: "2026-09-02T18:20:00Z" },
        { sourceId: "history:p-study-spot", postId: "p-study-spot", publishedAt: "2026-09-20T15:05:00Z" },
      ],
    ),
  },
  {
    id: "post-4",
    title: "Weekend away",
    date: "2026-10-30T21:10:00Z",
    historyPostId: "p-weekend",
    tone: "amber",
    sources: [{ id: "caption", type: "caption", text: WEEKEND_CAPTION }],
    result: sampleResult(
      "post-4",
      "2026-10-30T21:11:00Z",
      "This post says when you'll be away. Together with your move-in post, it points to an empty room.",
      [
        {
          id: "f1",
          category: "travel_absence",
          severity: "high",
          exposure: "Combined with your move-in post, this tells people which room will be empty from Friday to Sunday.",
          evidence: [
            { sourceId: "caption", quote: "Flying home Friday through Sunday", verified: true },
            { sourceId: "caption", quote: "Harlow Hall is going to be so quiet", verified: true },
            { sourceId: "history:p-move-in", quote: "Room 214 in Harlow Hall", verified: true },
          ],
          crossSource: true,
          confidence: "high",
          uncertainty: "Assumes you still live in the same room.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "generalize",
              original: "Flying home Friday through Sunday",
              replacement: "Heading home soon",
              explanation: "Leaves out the exact dates. Or post about the trip after you're back.",
            },
          ],
        },
        {
          id: "f2",
          category: "health",
          severity: "medium",
          exposure: "Mentions a family member's surgery, which is private health information.",
          evidence: [{ sourceId: "caption", quote: "Mom after her surgery", verified: true }],
          crossSource: false,
          confidence: "high",
          uncertainty: "You may be comfortable sharing this, but it's about someone else's health.",
          suggestedEdits: [
            {
              sourceId: "caption",
              action: "generalize",
              original: "to be with Mom after her surgery",
              replacement: "to see family",
              explanation: "Keeps your mom's health private.",
            },
          ],
        },
      ],
      [{ sourceId: "history:p-move-in", postId: "p-move-in", publishedAt: "2026-09-02T18:20:00Z" }],
    ),
  },
];
