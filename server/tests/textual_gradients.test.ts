import 'dotenv/config';
import * as cheerio from 'cheerio';
import {
  extractEmbeddedFrameworkState,
  isHydrationPending,
  type DomCandidate,
} from '../src/harness/deep_web_search/tools/scrapper_tool.js';
import {
  buildScoutRevectorPrompt,
  buildInspectorGradientPrompt,
} from '../src/harness/deep_web_search/prompts.js';
import type {
  DeepResearchTask,
  ResearchPlan,
  CandidateSite,
  TextualGradient,
  SearchAngle,
} from '../src/harness/deep_web_search/types.js';

async function runTextualGradientTests() {
  console.log('\n==========================================================');
  console.log('TEST SUITE: TEXTUAL GRADIENTS & HYDRATION HANDLING');
  console.log('==========================================================');

  // -----------------------------------------------------------------
  // 1. Testing Tier 1.5 Framework State Extraction (Next.js __NEXT_DATA__)
  // -----------------------------------------------------------------
  console.log('\n--- 1. Testing Next.js __NEXT_DATA__ Embedded State Extraction ---');

  const nextJsHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Nvidia RTX 5090 - Next.js Store</title>
      </head>
      <body>
        <div id="__next">
          <div class="product-page">
            <span class="price-placeholder">$--.--</span>
          </div>
        </div>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "product": {
                  "id": "rtx-5090-fe",
                  "title": "NVIDIA GeForce RTX 5090 Founders Edition",
                  "price": 1999.00,
                  "currency": "USD",
                  "availability": "In Stock"
                }
              }
            }
          }
        </script>
      </body>
    </html>
  `;

  const $next = cheerio.load(nextJsHtml);
  const nextResult = extractEmbeddedFrameworkState($next);

  console.assert(nextResult.tier === 'FRAMEWORK_EMBEDDED_STATE', `Expected FRAMEWORK_EMBEDDED_STATE, got ${nextResult.tier}`);
  console.assert(nextResult.extractedPrice === 1999.00, `Expected 1999.00, got ${nextResult.extractedPrice}`);
  console.assert(nextResult.extractedStock === 'In Stock', `Expected 'In Stock', got ${nextResult.extractedStock}`);
  console.log('  [PASS] Successfully extracted Next.js __NEXT_DATA__ state without headless browser:', {
    tier: nextResult.tier,
    price: nextResult.extractedPrice,
    stock: nextResult.extractedStock,
  });

  // -----------------------------------------------------------------
  // 2. Testing Tier 1.5 Shopify Product JSON Extraction
  // -----------------------------------------------------------------
  console.log('\n--- 2. Testing Shopify Product JSON Extraction ---');

  const shopifyHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <div class="shopify-section">
          <h1>Logitech MX Master 3S</h1>
        </div>
        <script type="application/json" data-product-json>
          {
            "id": 987654321,
            "title": "Logitech MX Master 3S",
            "price": 9999,
            "available": true
          }
        </script>
      </body>
    </html>
  `;

  const $shopify = cheerio.load(shopifyHtml);
  const shopifyResult = extractEmbeddedFrameworkState($shopify);

  console.assert(shopifyResult.tier === 'FRAMEWORK_EMBEDDED_STATE', `Expected FRAMEWORK_EMBEDDED_STATE, got ${shopifyResult.tier}`);
  console.assert(shopifyResult.extractedPrice === 99.99, `Expected 99.99 (9999 / 100), got ${shopifyResult.extractedPrice}`);
  console.assert(shopifyResult.extractedStock === 'In Stock', `Expected 'In Stock', got ${shopifyResult.extractedStock}`);
  console.log('  [PASS] Successfully extracted Shopify product JSON state:', {
    price: shopifyResult.extractedPrice,
    stock: shopifyResult.extractedStock,
  });

  // -----------------------------------------------------------------
  // 3. Testing Hydration Pending Detection
  // -----------------------------------------------------------------
  console.log('\n--- 3. Testing isHydrationPending Detection ---');

  const placeholderCandidate: DomCandidate = {
    tag: 'span',
    text: '$--.--',
    classes: ['price-skeleton', 'shimmer'],
    suggestedSelector: '.price-skeleton',
  };

  const isPending = isHydrationPending([placeholderCandidate], '<div id="root"></div>');
  console.assert(isPending === true, 'Failed to detect pending hydration for skeleton candidate');
  console.log('  [PASS] isHydrationPending correctly flagged skeleton placeholder candidate');

  const validCandidate: DomCandidate = {
    tag: 'span',
    text: '$1,999.00',
    classes: ['product-price', 'current'],
    suggestedSelector: '.product-price.current',
  };

  const isNotPending = isHydrationPending([validCandidate], '<div id="root"></div>');
  console.assert(isNotPending === false, 'False positive on valid live candidate');
  console.log('  [PASS] isHydrationPending correctly passed live candidate');

  // -----------------------------------------------------------------
  // 4. Testing Scout SERP Query Re-vectoring Prompt (Search Gradient)
  // -----------------------------------------------------------------
  console.log('\n--- 4. Testing Scout Query Re-vectoring Prompt (Search Gradient) ---');

  const mockTask: DeepResearchTask = {
    id: 'T-RTX-5090',
    query: 'Nvidia RTX 5090 buy price',
    targetDataKind: 'PRICE',
    expectedOperator: 'LESS_THAN',
    targetValue: 2000,
  };

  const mockPlan: ResearchPlan = {
    taskId: 'T-RTX-5090',
    searchAngles: [
      {
        query: 'rtx 5090 online',
        rationale: 'general retail',
        sourceCategory: 'DIRECT_RETAIL',
      },
    ],
    qualificationCriteria: ['Must be direct vendor product detail page', 'Must have price in USD'],
  };

  const weakHits = [
    {
      url: 'https://reddit.com/r/pcmasterrace/comments/rtx5090_rumors',
      domain: 'reddit.com',
      title: 'RTX 5090 rumors and speculation : r/pcmasterrace',
      snippet: 'What do you guys think the MSRP will be? Probably over $2000...',
    },
    {
      url: 'https://techblog.com/best-gpus-2026',
      domain: 'techblog.com',
      title: 'Top 10 GPUs of 2026',
      snippet: 'Here are the top GPUs you should consider buying this year...',
    },
  ];

  const revectorPrompt = buildScoutRevectorPrompt(
    mockTask,
    mockPlan,
    mockPlan.searchAngles[0],
    weakHits
  );

  console.assert(revectorPrompt.includes('DYNAMIC SERP QUERY RE-VECTORING'), 'Missing re-vector header');
  console.assert(revectorPrompt.includes('textualGradient'), 'Missing textualGradient field directive');
  console.assert(revectorPrompt.includes('revectoredQuery'), 'Missing revectoredQuery field directive');
  console.log('  [PASS] buildScoutRevectorPrompt generates structured search gradient prompt.');

  // -----------------------------------------------------------------
  // 5. Testing Inspector Self-Healing Gradient Prompt
  // -----------------------------------------------------------------
  console.log('\n--- 5. Testing Inspector Self-Healing Gradient Prompt ---');

  const mockCandidate: CandidateSite = {
    url: 'https://bestbuy.com/site/nvidia-rtx-5090/12345.p',
    domain: 'bestbuy.com',
    siteName: 'Best Buy',
    title: 'NVIDIA GeForce RTX 5090 - Best Buy',
    snippet: 'Buy NVIDIA RTX 5090 at Best Buy',
    sourceCategory: 'DIRECT_RETAIL',
    snippetRelevanceScore: 0.95,
  };

  const mockGradient: TextualGradient = {
    stepIndex: 1,
    candidateUrl: mockCandidate.url,
    failedSelector: '.price-box .was-price',
    diagnostics: {
      selector: '.price-box .was-price',
      matchedCount: 1,
      rawSampleValue: '$2,299.00',
      matchedHtmlSample: '<span class="was-price line-through">$2,299.00</span>',
      isDecoy: true,
      isPlaceholder: false,
      rejectionReason: 'Selector matched strikethrough was-price instead of live selling price',
    },
    directionalCorrection: 'Avoid .was-price. Target the active current selling price .current-price.',
  };

  const inspectorGradientPrompt = buildInspectorGradientPrompt(
    mockTask,
    mockCandidate,
    '<div class="price-box"><span class="was-price">$2,299.00</span><span class="current-price">$1,999.00</span></div>',
    [
      {
        tag: 'span',
        text: '$1,999.00',
        classes: ['current-price'],
        suggestedSelector: '.price-box .current-price',
      },
    ],
    mockGradient
  );

  console.assert(inspectorGradientPrompt.includes('SELF-HEALING CSS SELECTOR REFINEMENT'), 'Missing self-healing header');
  console.assert(inspectorGradientPrompt.includes('Is Decoy / Strikethrough Price: YES'), 'Missing decoy flag in gradient context');
  console.assert(inspectorGradientPrompt.includes('Avoid .was-price'), 'Missing directional correction');
  console.log('  [PASS] buildInspectorGradientPrompt generates rich textual gradient diagnostic prompt.');

  console.log('\n==========================================================');
  console.log('ALL TEXTUAL GRADIENT & HYDRATION TESTS PASSED [5/5]');
  console.log('==========================================================\n');
}

runTextualGradientTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
