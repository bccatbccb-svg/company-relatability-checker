/**
 * Custom Apify Actor: Relevance Scorer for Window Coverings / Home Automation / Architecture
 *
 * Analyzes company websites to determine if they work with:
 * - Window coverings (blinds, shades, shutters, etc.)
 * - Home automation / smart home
 * - Residential architecture / interior design
 *
 * KEY FEATURES:
 * - Fetches multiple pages (homepage, about us, services) with intelligent URL detection
 * - Position-weighted scoring (primary service = higher weight)
 * - Detects secondary services ("also offer", "in addition to", etc.)
 * - Meta tag & title extraction (fallback content for text-light sites)
 * - Schema.org/JSON-LD extraction (structured data, invisible on rendered page)
 * - Portfolio-site detection with confidence boost (image-heavy / gallery sites)
 * - Context-aware Gemini prompts (different prompt when text is sparse/portfolio-style)
 * - Detailed logging for iteration and tuning
 *
 * Outputs: Relevance score, matched keywords, confidence level, recommendation, detailed logs
 */

import { Actor } from 'apify';
import axios from 'axios';
import cheerio from 'cheerio';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Keyword dictionaries for identifying primary service
const KEYWORDS = {
  // TARGET CATEGORIES - Our 4 focus areas
  windowCoverings: [
    'window covering', 'window coverings', 'blinds', 'shades', 'shutters', 'roller shade',
    'vertical blind', 'motorized shade', 'motorized blind', 'smart shade', 'automated shade',
    'window treatment', 'window blind', 'cellular shade', 'roman shade', 'panel track blind',
    'motorized blind', 'automated window treatment', 'window shade',
    'hunter douglas', 'lutron shades', 'somfy', 'pella', 'graber', 'levolor',
  ],

  homeAutomation: [
    'home automation', 'smart home', 'home automation system', 'smart control', 'voice control',
    'smart integration', 'home automation design', 'connected home', 'smart home integration',
    'automated lighting', 'smart thermostat', 'smart door', 'home connectivity',
    'lutron', 'control4', 'savant', 'crestron', 'elan',
  ],

  architecture: [
    'architect', 'architecture', 'architecture firm', 'architectural design', 'architectural services',
    'architectural firm', 'building design', 'design architecture', 'residential architect',
  ],

  interiorDesign: [
    'interior design', 'interior designer', 'interior designer', 'interior decorator',
    'interior decoration', 'interior styling', 'residential interiors', 'home interior design',
    'interior redesign', 'interior architect',
  ],

  // IRRELEVANT - Primary services to avoid
  irrelevant: [
    // Construction/Contracting
    'general contractor', 'construction company', 'contractor', 'construction services',
    'contractor services', 'roofing', 'framing', 'drywall', 'painting contractor',
    'plumbing', 'electrical contractor', 'hvac', 'structural engineer', 'engineering',
    'concrete contractor', 'masonry', 'carpentry',

    // Land/Planning
    'land planning', 'land developer', 'development company', 'real estate development',
    'regulatory compliance', 'permitting', 'permit services', 'land surveying',
    'environmental consulting',

    // Retail/Commercial
    'furniture store', 'furniture retailer', 'furniture company', 'flooring retailer',
    'flooring company', 'tile company', 'carpet', 'appliance store', 'window replacement',
    'retail store', 'furniture gallery', 'home furnishings',

    // Hospitality/Commercial
    'hospitality', 'hotel design', 'restaurant design', 'commercial contractor',
    'office furniture', 'corporate design', 'retail design', 'commercial kitchen',

    // Home Services
    'home services', 'home maintenance', 'cleaning service', 'landscaping', 'lawn care',
    'painting service', 'repair service', 'maintenance service',
  ],
};

/**
 * Intelligently fetch About Us page
 */
async function fetchAboutPage(baseUrl) {
  const patterns = [
    '/about',
    '/about-us',
    '/team',
    '/company',
    '/who-we-are',
    '/our-team',
    '/about-our-firm',
  ];

  for (const pattern of patterns) {
    try {
      const testUrl = new URL(baseUrl).origin + pattern;
      const response = await axios.head(testUrl, {
        timeout: 5000,
        headers: { 'User-Agent': 'Apify Relevance Scorer' },
      });
      if (response.status === 200) {
        return testUrl;
      }
    } catch (e) {
      // Continue to next pattern
    }
  }

  try {
    const response = await axios.get(baseUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'Apify Relevance Scorer' },
    });

    const $ = cheerio.load(response.data);
    const links = $('a');

    for (let i = 0; i < links.length; i++) {
      const text = $(links[i]).text().toLowerCase();
      const href = $(links[i]).attr('href');

      if (href && (text.includes('about') || text.includes('who we are') || text.includes('our firm'))) {
        try {
          const aboutUrl = new URL(href, baseUrl).href;
          if (new URL(aboutUrl).origin === new URL(baseUrl).origin) {
            return aboutUrl;
          }
        } catch (e) {
          // Invalid URL, continue
        }
      }
    }
  } catch (e) {
    console.error(`Error detecting about page for ${baseUrl}: ${e.message}`);
  }

  return null;
}

/**
 * Intelligently fetch Services page
 */
async function fetchServicesPage(baseUrl) {
  const patterns = [
    '/services',
    '/what-we-do',
    '/our-services',
    '/offerings',
    '/capabilities',
    '/expertise',
  ];

  for (const pattern of patterns) {
    try {
      const testUrl = new URL(baseUrl).origin + pattern;
      const response = await axios.head(testUrl, {
        timeout: 5000,
        headers: { 'User-Agent': 'Apify Relevance Scorer' },
      });
      if (response.status === 200) {
        return testUrl;
      }
    } catch (e) {
      // Continue
    }
  }

  return null;
}

/**
 * Extract meta title & description from <head>
 */
function extractMetaTags($) {
  const metaTitle = $('title').first().text().trim() || null;

  let metaDescription =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    null;

  metaDescription = metaDescription ? metaDescription.trim() : null;

  const ogTitle = $('meta[property="og:title"]').attr('content');

  return {
    metaTitle: metaTitle || (ogTitle ? ogTitle.trim() : null),
    metaDescription,
  };
}

/**
 * Extract Schema.org / JSON-LD structured data from <script type="application/ld+json"> blocks.
 * Sites often embed serviceType / description / areaServed here even when the
 * rendered page is 100% images.
 */
function extractSchemaData($) {
  const scripts = $('script[type="application/ld+json"]');
  const collected = [];

  scripts.each((i, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;

    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      items.forEach((item) => {
        // Some sites nest relevant data under @graph
        const graphItems = Array.isArray(item['@graph']) ? item['@graph'] : [item];

        graphItems.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;

          const relevant = {
            type: entry['@type'] || null,
            name: entry.name || null,
            description: entry.description || null,
            serviceType: entry.serviceType || null,
            areaServed: entry.areaServed || null,
            knowsAbout: entry.knowsAbout || null,
          };

          // Only keep entries that actually contain useful signal
          if (relevant.description || relevant.serviceType || relevant.knowsAbout || relevant.name) {
            collected.push(relevant);
          }
        });
      });
    } catch (e) {
      // Malformed JSON-LD - skip silently, don't break extraction
    }
  });

  return collected.length > 0 ? collected : null;
}

/**
 * Detect portfolio/gallery-heavy structure so we don't penalize sites
 * for having little body text when that's expected for their category.
 */
function detectPortfolioSignals($, textLength) {
  const imageCount = $('img').length;
  const galleryElements = $('[class*="gallery"], [class*="portfolio"], [id*="gallery"], [id*="portfolio"]').length;

  // Avoid divide-by-zero; treat near-empty text as a large ratio
  const safeTextLength = Math.max(textLength, 1);
  const imageToTextRatio = imageCount / (safeTextLength / 100);

  const isPortfolioSite = imageCount >= 8 && (galleryElements > 0 || imageToTextRatio > 2.0) && textLength < 800;

  return {
    imageCount,
    galleryElements,
    imageToTextRatio: Math.round(imageToTextRatio * 10) / 10,
    isPortfolioSite,
  };
}

/**
 * Turn an axios error into a short, useful diagnostic string instead of a
 * generic message — distinguishes timeouts, DNS failures, connection resets,
 * and HTTP error status codes (403/404/500 etc.) from each other.
 */
function describeFetchError(error) {
  if (error.response) {
    return `HTTP ${error.response.status}`;
  }
  if (error.code === 'ECONNABORTED') {
    return 'timeout';
  }
  if (error.code) {
    return error.code; // e.g. ENOTFOUND, ECONNRESET, ECONNREFUSED
  }
  return error.message || 'unknown error';
}

/**
 * Extract text + metadata from webpage with better section detection
 * Depth: 3500-4000 characters per page
 *
 * Returns an object instead of a plain string so callers have access to
 * meta tags, schema data, and portfolio signals alongside the body text.
 */
async function extractPageContent(url, pageType = 'homepage') {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Apify Relevance Scorer' },
    });

    const $ = cheerio.load(response.data);

    // Extract head-level signals BEFORE stripping anything
    const { metaTitle, metaDescription } = extractMetaTags($);
    const schemaData = extractSchemaData($);

    // Remove noise for body text extraction
    $('script, style, nav, footer, .nav, .navigation, .sidebar, .widget').remove();

    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const bodyText = text.substring(0, 3500).trim();

    const portfolioSignals = detectPortfolioSignals($, text.length);

    return {
      bodyText,
      metaTitle,
      metaDescription,
      schemaData,
      ...portfolioSignals,
      fetchError: null,
    };
  } catch (error) {
    const reason = describeFetchError(error);
    console.error(`Error fetching ${url} (${pageType}): ${reason}`);
    return {
      bodyText: null,
      metaTitle: null,
      metaDescription: null,
      schemaData: null,
      imageCount: 0,
      galleryElements: 0,
      imageToTextRatio: 0,
      isPortfolioSite: false,
      fetchError: reason,
    };
  }
}

/**
 * Enhanced text cleaning - remove navigation, social media, junk content
 */
function cleanPageText(text) {
  if (!text || text.length < 50) return '';

  let cleaned = text;

  cleaned = cleaned.replace(/\b(menu|nav|navigation|instagram|linkedin|twitter|facebook|youtube|contact us|follow us)\b/gi, '');
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
  cleaned = cleaned.replace(/www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  cleaned = cleaned.replace(/\(?[0-9]{3}[-.]?[0-9]{3}[-.]?[0-9]{4}\)?/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned.substring(0, 1500);
}

/**
 * Flatten schema.org entries into a short readable string for prompts/logging.
 */
function formatSchemaForPrompt(schemaData) {
  if (!schemaData || schemaData.length === 0) return null;

  return schemaData
    .map((entry) => {
      const parts = [];
      if (entry.type) parts.push(`Type: ${entry.type}`);
      if (entry.name) parts.push(`Name: ${entry.name}`);
      if (entry.serviceType) parts.push(`Service: ${entry.serviceType}`);
      if (entry.description) parts.push(`Description: ${entry.description}`);
      if (entry.areaServed) parts.push(`Area served: ${JSON.stringify(entry.areaServed)}`);
      if (entry.knowsAbout) parts.push(`Knows about: ${JSON.stringify(entry.knowsAbout)}`);
      return parts.join(' | ');
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Generate summary using Gemini API
 */
async function generateGeminiSummary(cleanedText, geminiApiKey, supplementalContext = {}) {
  const { metaDescription, schemaSummary, isPortfolioSite } = supplementalContext;

  const hasSupplemental = metaDescription || schemaSummary;

  if ((!cleanedText || cleanedText.length < 30) && !hasSupplemental) {
    console.log('    ⚠️  No usable content (body/meta/schema) for Gemini, using fallback');
    return 'Unable to determine services';
  }

  if (!geminiApiKey) {
    console.log('    ⚠️  No Gemini API key - skipping summary');
    return 'Gemini API key not provided';
  }

  try {
    console.log('    → Calling Gemini for summary...');
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

    let prompt;

    if (isPortfolioSite || (cleanedText.length < 150 && hasSupplemental)) {
      prompt = `This is a portfolio/gallery-style website with minimal body text (common for architecture and design firms). Use ALL signals below to summarize what the company primarily offers.

Meta description: ${metaDescription || 'none found'}
Structured data (schema.org): ${schemaSummary || 'none found'}
Available page text: ${cleanedText || 'minimal/none'}

Provide a brief 1-2 sentence summary of what services or products this company primarily offers. Focus only on their main business, not side offerings. Be concise and professional.

Summary (1-2 sentences only):`;
    } else {
      prompt = `Based on the following website text, provide a brief 1-2 sentence summary of what services or products this company primarily offers. Focus only on their main business, not side offerings. Be concise and professional.

Website text:
${cleanedText}

Summary (1-2 sentences only):`;
    }

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    console.log('    ✓ Gemini summary generated');

    let summary = responseText.trim();
    summary = summary.replace(/^["']|["']$/g, '');

    if (summary.length > 300) {
      summary = summary.substring(0, 300).trim() + '...';
    }

    return summary;
  } catch (error) {
    console.error('    ❌ Gemini summary error:', error.message);
    return `[Gemini Error: ${error.message.substring(0, 50)}]`;
  }
}

/**
 * Fallback: Query Gemini about company using just URL/domain name
 */
async function queryGeminiFallback(url, geminiApiKey) {
  if (!geminiApiKey) {
    return null;
  }

  try {
    console.log(`  → Fallback: Querying Gemini about ${url}`);
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

    const domain = url.replace(/https?:\/\/(www\.)?/, '').split('/')[0];

    const prompt = `Based on your knowledge, what is the primary business or services of the company at ${domain}? Provide a brief 1-2 sentence summary of what they do. If you don't have information about this company, say so directly.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let summary = responseText.trim();
    summary = summary.replace(/^["']|["']$/g, '');

    if (summary.length > 300) {
      summary = summary.substring(0, 300).trim() + '...';
    }

    console.log(`  ✓ Fallback response: ${summary.substring(0, 80)}...`);
    return summary;
  } catch (error) {
    console.error(`  ❌ Fallback query failed:`, error.message);
    return null;
  }
}

/**
 * Build the verification prompt, choosing a context-aware template when
 * text is sparse / the site looks like a portfolio, and a standard
 * template when there's plenty of body text to work with.
 */
function buildVerificationPrompt(cleanedText, context) {
  const { isPortfolioSite, metaTitle, metaDescription, schemaSummary, domain } = context;

  const sparse = !cleanedText || cleanedText.length < 150;

  if (isPortfolioSite || sparse) {
    return `This appears to be a portfolio/gallery-heavy website with minimal body text (common for architecture and design firms who lead with visuals rather than copy).

Domain: ${domain}
Page title: ${metaTitle || 'none found'}
Meta description: ${metaDescription || 'none found'}
Structured data (schema.org): ${schemaSummary || 'none found'}
Available page text: ${cleanedText || 'minimal/none'}

Using ALL available signals above (not just body text), determine their PRIMARY service category. Choose ONE:
1. Window coverings/treatments
2. Home automation/smart home
3. Architecture
4. Interior design
5. None of the above

Answer with just the category name and 1 sentence explaining why, noting explicitly if your answer relies mainly on domain/meta/schema signals rather than page copy.`;
  }

  return `Based on the following website text about a company, determine their PRIMARY service category. Choose ONE:
1. Window coverings/treatments
2. Home automation/smart home
3. Architecture
4. Interior design
5. None of the above

Website text:
${cleanedText}

What is their PRIMARY service? Answer with just the category name and 1 sentence explaining why.`;
}

/**
 * Parse Gemini's verification response to figure out which target category
 * (if any) it named. The verification prompt asks Gemini to lead with the
 * category name, so we match against the first line only — this avoids
 * false-positive matches from category names mentioned later while
 * explaining why something DOESN'T fit.
 */
function parseGeminiCategory(geminiVerification) {
  if (!geminiVerification) return null;

  const firstLine = geminiVerification.split('\n')[0].toLowerCase();

  if (firstLine.includes('none of the above')) return null;
  if (firstLine.includes('window covering') || firstLine.includes('window treatment')) return 'windowCoverings';
  if (firstLine.includes('home automation') || firstLine.includes('smart home')) return 'homeAutomation';
  if (firstLine.includes('interior design')) return 'interiorDesign';
  if (firstLine.includes('architecture')) return 'architecture';

  return null;
}

/**
 * Verification: Ask Gemini to validate our keyword findings
 */
async function verifyWithGemini(pages, url, geminiApiKey) {
  if (!geminiApiKey) {
    return null;
  }

  try {
    console.log(`    → Calling Gemini for verification...`);
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

    const primaryPage = pages.about || pages.services || pages.homepage || null;
    const textToAnalyze = primaryPage?.bodyText || '';
    const cleanedText = cleanPageText(textToAnalyze).substring(0, 1000);

    // Pull supplemental signals from whichever page has them (prefer homepage,
    // since portfolio homepages are the primary case we're solving for)
    const metaTitle = pages.homepage?.metaTitle || pages.about?.metaTitle || pages.services?.metaTitle || null;
    const metaDescription =
      pages.homepage?.metaDescription || pages.about?.metaDescription || pages.services?.metaDescription || null;
    const schemaData = pages.homepage?.schemaData || pages.about?.schemaData || pages.services?.schemaData || null;
    const schemaSummary = formatSchemaForPrompt(schemaData);

    const isPortfolioSite = !!(pages.homepage?.isPortfolioSite || pages.about?.isPortfolioSite || pages.services?.isPortfolioSite);

    const hasSupplemental = metaDescription || schemaSummary;

    if ((!cleanedText || cleanedText.length < 20) && !hasSupplemental) {
      console.log(`    ⚠️  Not enough content for verification`);
      return null;
    }

    const domain = url.replace(/https?:\/\/(www\.)?/, '').split('/')[0];

    const prompt = buildVerificationPrompt(cleanedText, {
      isPortfolioSite,
      metaTitle,
      metaDescription,
      schemaSummary,
      domain,
    });

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    console.log(`    ✓ Gemini verification complete`);
    return responseText.trim();
  } catch (error) {
    console.error(`    ❌ Verification error:`, error.message);
    return null;
  }
}

/**
 * Extract a brief summary of company services from content
 */
async function extractServicesSummary(pages, geminiApiKey, url) {
  const primaryPage = pages.about || pages.services || pages.homepage || null;
  const textToAnalyze = primaryPage?.bodyText || '';

  const metaDescription =
    pages.homepage?.metaDescription || pages.about?.metaDescription || pages.services?.metaDescription || null;
  const schemaData = pages.homepage?.schemaData || pages.about?.schemaData || pages.services?.schemaData || null;
  const schemaSummary = formatSchemaForPrompt(schemaData);
  const isPortfolioSite = !!(pages.homepage?.isPortfolioSite || pages.about?.isPortfolioSite || pages.services?.isPortfolioSite);

  if (!textToAnalyze && !metaDescription && !schemaSummary) {
    console.log(`  ⚠️  No page content, meta, or schema found - using Gemini fallback`);
    const fallbackSummary = await queryGeminiFallback(url, geminiApiKey);
    return fallbackSummary || 'Unable to determine services';
  }

  const cleanedText = cleanPageText(textToAnalyze);

  const summary = await generateGeminiSummary(cleanedText, geminiApiKey, {
    metaDescription,
    schemaSummary,
    isPortfolioSite,
  });

  return summary;
}

/**
 * Add domain-based weighting for URL signals
 */
function getDomainWeight(url) {
  const domain = url.toLowerCase();
  let domainWeight = 0;

  if (domain.includes('architect')) {
    domainWeight += 25;
  }
  if (domain.includes('design') && domain.includes('arch')) {
    domainWeight += 10;
  }

  return domainWeight;
}

/**
 * Identify primary service and match against 4 target categories
 */
async function analyzeServiceFit(pages, company, url, geminiApiKey) {
  // pages = { homepage: {bodyText, metaTitle, metaDescription, schemaData, ...}, about: {...}, services: {...} }

  let scores = {
    windowCoverings: { matches: 0, weight: 0 },
    homeAutomation: { matches: 0, weight: 0 },
    architecture: { matches: 0, weight: 0 },
    interiorDesign: { matches: 0, weight: 0 },
    irrelevant: { matches: 0, weight: 0 },
  };

  const domainWeight = getDomainWeight(url);
  if (domainWeight > 0) {
    scores.architecture.weight += domainWeight;
    scores.architecture.matches += 0;
  }

  let matchLog = [];
  let primaryServiceCategory = null;
  let primaryServiceKeyword = null;
  let servicesSummary = await extractServicesSummary(pages, geminiApiKey, url);

  // Portfolio signal aggregated across pages (mainly homepage)
  const isPortfolioSite = !!(pages.homepage?.isPortfolioSite || pages.about?.isPortfolioSite || pages.services?.isPortfolioSite);

  let geminiVerification = null;
  const totalContentLength =
    (pages.homepage?.bodyText?.length || 0) +
    (pages.about?.bodyText?.length || 0) +
    (pages.services?.bodyText?.length || 0);

  const totalMetaSchemaLength =
    (pages.homepage?.metaDescription?.length || 0) +
    (pages.about?.metaDescription?.length || 0) +
    (pages.services?.metaDescription?.length || 0) +
    (formatSchemaForPrompt(pages.homepage?.schemaData)?.length || 0);

  const urlHasArchitectSignal = url.toLowerCase().includes('architect');

  // Run verification if we have body content, meta/schema content, OR a strong domain signal
  if ((totalContentLength > 150 || totalMetaSchemaLength > 30 || urlHasArchitectSignal) && geminiApiKey) {
    try {
      geminiVerification = await verifyWithGemini(pages, url, geminiApiKey);
    } catch (error) {
      console.error(`  ⚠️ Verification error:`, error.message);
      geminiVerification = null;
    }
  }

  // Process each page with different weights
  const pageWeights = {
    homepage: 1.0,
    about: 2.5,
    services: 3.0,
  };

  Object.entries(pages).forEach(([pageType, pageData]) => {
    if (!pageData) return;

    // Combine body text with meta description and flattened schema text so
    // keyword matching can pick up services that only appear in <head> data
    const schemaFlatText = formatSchemaForPrompt(pageData.schemaData) || '';
    const combinedText = [pageData.bodyText, pageData.metaTitle, pageData.metaDescription, schemaFlatText]
      .filter(Boolean)
      .join(' ');

    if (!combinedText) return;

    const lowerText = combinedText.toLowerCase();
    const pageWeight = pageWeights[pageType] || 1.0;

    const primarySection = combinedText.substring(0, 1000).toLowerCase();

    Object.entries(KEYWORDS).forEach(([category, keywords]) => {
      keywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        const matches = lowerText.match(regex) || [];

        if (matches.length > 0) {
          const positionMultiplier = primarySection.includes(keyword.toLowerCase()) ? 3 : 1;
          const weight = matches.length * pageWeight * positionMultiplier;

          scores[category].matches += matches.length;
          scores[category].weight += weight;

          matchLog.push({
            category,
            keyword,
            pageType,
            count: matches.length,
            weight: Math.round(weight * 10) / 10,
            inPrimarySection: primarySection.includes(keyword.toLowerCase()),
          });

          if (primarySection.includes(keyword.toLowerCase())) {
            if (!primaryServiceCategory || weight > scores[primaryServiceCategory].weight) {
              primaryServiceCategory = category;
              primaryServiceKeyword = keyword;
            }
          }
        }
      });
    });
  });

  Object.keys(scores).forEach(key => {
    scores[key].weight = Math.round(scores[key].weight * 10) / 10;
  });

  if (!primaryServiceCategory && scores.architecture.weight >= 25) {
    primaryServiceCategory = 'architecture';
    primaryServiceKeyword = 'domain-based (architect in URL)';
    console.log(`  ℹ️  Domain weighting identified: architecture (from URL)`);
  }

  // Determine recommendation based on PRIMARY service
  let recommendation = 'SKIP';
  let confidence = 'low';
  let reasoning = '';
  let targetCategoryMatch = null;

  const targetCategories = ['windowCoverings', 'homeAutomation', 'architecture', 'interiorDesign'];

  // Portfolio confidence boost: lower the weight bar needed for KEEP/high confidence
  // when the site is confirmed portfolio-structure AND the domain also signals
  // architecture/design. This stops penalizing sites for having images instead of text.
  const portfolioBoostEligible = isPortfolioSite && domainWeight > 0;
  const highThreshold = portfolioBoostEligible ? 15 : 25;
  const mediumThreshold = portfolioBoostEligible ? 8 : 15;
  const lowThreshold = portfolioBoostEligible ? 5 : 10;

  if (scores.irrelevant.weight > (scores.windowCoverings.weight + scores.homeAutomation.weight + scores.architecture.weight + scores.interiorDesign.weight)) {
    recommendation = 'SKIP';
    confidence = 'high';
    reasoning = `Primary service appears to be: ${primaryServiceKeyword || 'other'}. Not a fit for BCC (${primaryServiceCategory || 'irrelevant industry'}).`;
  } else if (primaryServiceCategory && targetCategories.includes(primaryServiceCategory)) {
    targetCategoryMatch = primaryServiceCategory;

    if (scores[primaryServiceCategory].weight >= highThreshold) {
      recommendation = 'KEEP';
      confidence = 'high';
      reasoning = `Primary service is ${primaryServiceCategory}: ${primaryServiceKeyword}. Strong fit for BCC.`;
      if (portfolioBoostEligible) {
        reasoning += ' (Portfolio-site confidence boost applied: image-heavy structure + architecture domain signal.)';
      }
    } else if (scores[primaryServiceCategory].weight >= mediumThreshold) {
      recommendation = 'KEEP';
      confidence = 'medium';
      reasoning = `Primary service appears to be ${primaryServiceCategory}: ${primaryServiceKeyword}. Good fit for BCC.`;
      if (portfolioBoostEligible) {
        reasoning += ' (Portfolio-site confidence boost applied.)';
      }
    } else if (scores[primaryServiceCategory].weight >= lowThreshold) {
      recommendation = 'KEEP';
      confidence = 'low';
      reasoning = `Primary service might be ${primaryServiceCategory}: ${primaryServiceKeyword}. Potential fit for BCC.`;
    } else {
      recommendation = 'MAYBE';
      confidence = 'low';
      reasoning = `Offers ${primaryServiceCategory} services but signals are weak. Manual review recommended.`;
    }
  } else if (isPortfolioSite && domainWeight > 0) {
    // No keyword-based primary service found, but structure + domain strongly
    // suggest architecture/design and text was simply too sparse to match keywords
    recommendation = 'MAYBE';
    confidence = 'medium';
    targetCategoryMatch = 'architecture';
    reasoning = `Portfolio-style site with minimal text; domain and structure suggest architecture/design. Manual review recommended (low text volume limited keyword matching).`;
  } else if ((scores.windowCoverings.weight + scores.homeAutomation.weight + scores.architecture.weight + scores.interiorDesign.weight) > 5) {
    recommendation = 'MAYBE';
    confidence = 'medium';
    reasoning = `Services are unclear or mixed. Could be relevant. Manual review recommended.`;
  } else {
    recommendation = 'SKIP';
    confidence = 'medium';
    reasoning = `No clear service match found. Does not appear to work with target categories.`;
  }

  // --- Gemini thin-keyword override -----------------------------------
  // When on-page keyword evidence is thin, let Gemini's independent read
  // break the tie IF it agrees on a target category. This only fires on
  // the two "weak signal" branches above — it does NOT touch the
  // irrelevant-dominant SKIP branch, since that reflects a real keyword
  // conflict (e.g. heavy "engineering" language), not thin evidence, and
  // Gemini already gets a chance to override that case on its own by
  // returning "None of the above" for a true irrelevant match.
  const geminiCategory = parseGeminiCategory(geminiVerification);
  const isThinKeywordMaybe = recommendation === 'MAYBE' && reasoning.startsWith('Offers');
  const isThinKeywordSkip = recommendation === 'SKIP' && reasoning.startsWith('No clear service match found');

  if (geminiCategory && isThinKeywordMaybe && geminiCategory === primaryServiceCategory) {
    // Keyword signal already pointed at this category, just too weak to KEEP on its own.
    // Gemini independently confirming the same category is enough to upgrade to KEEP.
    recommendation = 'KEEP';
    confidence = 'low';
    targetCategoryMatch = geminiCategory;
    reasoning = `Primary service is ${geminiCategory}: ${primaryServiceKeyword}. On-page keyword signal was weak, but Gemini verification independently confirmed ${geminiCategory}. Upgraded from MAYBE (low confidence — recommend spot-checking).`;
  } else if (geminiCategory && isThinKeywordSkip) {
    // No keyword-based category identified at all, but Gemini found one from
    // meta/schema/portfolio signals. Upgrade one tier (not straight to KEEP,
    // since there's zero keyword corroboration here) so it surfaces for review.
    recommendation = 'MAYBE';
    confidence = 'low';
    targetCategoryMatch = geminiCategory;
    reasoning = `No on-page keyword match found, but Gemini verification independently identified ${geminiCategory} as the primary service. Upgraded from SKIP for manual review.`;
  }
  // ----------------------------------------------------------------------

  return {
    recommendation,
    confidence,
    primaryServiceIdentified: primaryServiceCategory ? `${primaryServiceCategory}: ${primaryServiceKeyword}` : 'Unclear',
    targetCategoryMatch: targetCategoryMatch || 'None',
    servicesSummary,
    geminiVerification,
    reasoning,
    isPortfolioSite,
    portfolioBoostApplied: portfolioBoostEligible,
    scores: {
      windowCoverings: scores.windowCoverings.weight,
      homeAutomation: scores.homeAutomation.weight,
      architecture: scores.architecture.weight,
      interiorDesign: scores.interiorDesign.weight,
      irrelevant: scores.irrelevant.weight,
    },
    matchLog,
  };
}

/**
 * Main actor logic
 */
Actor.main(async () => {
  const input = await Actor.getInput();
  console.log('Input:', JSON.stringify(input, null, 2));

  const urls = input?.urls || [];
  const geminiApiKey = input?.geminiApiKey || process.env.GEMINI_API_KEY;

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('No URLs provided. Input should contain "urls" array.');
  }

  if (!geminiApiKey) {
    console.warn('⚠️  WARNING: No Gemini API key provided. Summaries will use fallback.');
  } else {
    console.log('✓ Gemini API key received - summaries will be generated');
  }

  const dataset = await Actor.openDataset('results');
  const detailDataset = await Actor.openDataset('detail-logs');

  console.log('🧹 Clearing previous results...');
  await dataset.drop();
  await detailDataset.drop();

  const freshDataset = await Actor.openDataset('results');
  const freshDetailDataset = await Actor.openDataset('detail-logs');

  let processedCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);

    try {
      console.log('  → Fetching homepage...');
      const homepageData = await extractPageContent(url, 'homepage');

      if (homepageData.fetchError) {
        console.warn(`  ⚠️  Could not fetch homepage (${homepageData.fetchError}), will try about/services pages`);
      } else if (homepageData.isPortfolioSite) {
        console.log(`  ℹ️  Portfolio-style structure detected (images: ${homepageData.imageCount}, ratio: ${homepageData.imageToTextRatio})`);
      }

      let aboutData = null;
      const aboutUrl = await fetchAboutPage(url);
      if (aboutUrl) {
        console.log(`  → Found About page, fetching: ${aboutUrl}`);
        aboutData = await extractPageContent(aboutUrl, 'about');
      } else {
        console.log('  → No About page found');
      }

      let servicesData = null;
      const servicesUrl = await fetchServicesPage(url);
      if (servicesUrl) {
        console.log(`  → Found Services page, fetching: ${servicesUrl}`);
        servicesData = await extractPageContent(servicesUrl, 'services');
      } else {
        console.log('  → No Services page found');
      }

      const pages = {
        homepage: homepageData,
        about: aboutData,
        services: servicesData,
      };

      const hasAnyContent =
        homepageData?.bodyText || aboutData?.bodyText || servicesData?.bodyText ||
        homepageData?.metaDescription || homepageData?.schemaData;

      if (!hasAnyContent) {
        // Build a specific reason per page instead of a generic message, so
        // the output tells us WHY (timeout, DNS failure, HTTP 403/404/500,
        // or simply no page found at that URL pattern) rather than just THAT.
        const reasons = [];
        reasons.push(`homepage: ${homepageData.fetchError || 'fetched but empty (no text/meta/schema found)'}`);
        reasons.push(aboutUrl ? `about: ${aboutData?.fetchError || 'fetched but empty'}` : 'about: no about page found');
        reasons.push(servicesUrl ? `services: ${servicesData?.fetchError || 'fetched but empty'}` : 'services: no services page found');
        throw new Error(`Could not fetch any content from website (${reasons.join('; ')})`);
      }

      const analysis = await analyzeServiceFit(pages, url.split('/')[2], url, geminiApiKey);

      const result = {
        url,
        status: 'success',
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        servicesSummary: analysis.servicesSummary,
        primaryServiceIdentified: analysis.primaryServiceIdentified,
        targetCategoryMatch: analysis.targetCategoryMatch,
        reasoning: analysis.reasoning,
        isPortfolioSite: analysis.isPortfolioSite,
        portfolioBoostApplied: analysis.portfolioBoostApplied,
        windowCoveringsScore: analysis.scores.windowCoverings,
        homeAutomationScore: analysis.scores.homeAutomation,
        architectureScore: analysis.scores.architecture,
        interiorDesignScore: analysis.scores.interiorDesign,
        irrelevantScore: analysis.scores.irrelevant,
        pagesAnalyzed: {
          homepage: !!homepageData?.bodyText,
          about: !!aboutData?.bodyText,
          services: !!servicesData?.bodyText,
        },
        metaTitleFound: !!homepageData?.metaTitle,
        metaDescriptionFound: !!homepageData?.metaDescription,
        schemaDataFound: !!homepageData?.schemaData,
        geminiVerification: analysis.geminiVerification || 'No verification performed',
        timestamp: new Date(),
      };

      await freshDataset.pushData(result);

      const detailLog = {
        url,
        recommendation: analysis.recommendation,
        primaryServiceIdentified: analysis.primaryServiceIdentified,
        isPortfolioSite: analysis.isPortfolioSite,
        homepageMetaTitle: homepageData?.metaTitle || null,
        homepageMetaDescription: homepageData?.metaDescription || null,
        homepageSchemaData: homepageData?.schemaData || null,
        matchDetails: analysis.matchLog,
        totalMatches: analysis.matchLog.length,
        geminiVerification: analysis.geminiVerification || 'No verification performed',
        timestamp: new Date(),
      };

      await freshDetailDataset.pushData(detailLog);

      processedCount++;
      console.log(`  ✅ ${analysis.recommendation}`);

    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);

      await freshDataset.pushData({
        url,
        status: 'error',
        error: error.message,
        timestamp: new Date(),
      });
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  console.log(`\n✅ Completed analysis of ${processedCount}/${urls.length} URLs`);
  console.log(`Results saved to 'results' dataset`);
  console.log(`Detailed match logs saved to 'detail-logs' dataset`);
});
