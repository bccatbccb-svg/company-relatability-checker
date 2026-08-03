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
 * - Detailed logging for iteration and tuning
 * 
 * Outputs: Relevance score, matched keywords, confidence level, recommendation, detailed logs
 */

const Apify = require('apify');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
 * Tries URL patterns first, then falls back to link detection
 */
async function fetchAboutPage(baseUrl) {
  // URL patterns to try
  const patterns = [
    '/about',
    '/about-us',
    '/team',
    '/company',
    '/who-we-are',
    '/our-team',
    '/about-our-firm',
  ];

  // Try URL patterns first (fast)
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

  // Fall back to link text detection (slower but catches custom URLs)
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
          // Verify it's on same domain
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
 * Extract text from webpage with better section detection
 * Depth: 3500-4000 characters per page
 */
async function extractPageContent(url, pageType = 'homepage') {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Apify Relevance Scorer' },
    });

    const $ = cheerio.load(response.data);
    
    // Remove noise
    $('script, style, nav, footer, .nav, .navigation, .sidebar, .widget').remove();

    // Get main body text
    const text = $('body').text();
    
    // Return first 3500 chars (roughly 600 words)
    return text.substring(0, 3500).trim();
  } catch (error) {
    console.error(`Error fetching ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Enhanced text cleaning - remove navigation, social media, junk content
 */
function cleanPageText(text) {
  if (!text) return '';
  
  let cleaned = text;
  
  // Remove common navigation/menu items
  cleaned = cleaned.replace(/\b(menu|nav|navigation|home|about|contact|services|portfolio|blog|news|resources|careers|search|skip to content|instagram|linkedin|twitter|facebook|youtube)\b/gi, '');
  
  // Remove social media links and emails
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  cleaned = cleaned.replace(/www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  
  // Remove URLs
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
  
  // Remove phone numbers
  cleaned = cleaned.replace(/\(?[\d\s\-\.]+\)?/g, '');
  
  // Remove common UI text
  cleaned = cleaned.replace(/\b(click here|read more|learn more|view|expand|show more|hide|toggle|open|close)\b/gi, '');
  
  // Remove extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Keep only first 1500 characters of cleaned text (good content usually early)
  return cleaned.substring(0, 1500);
}

/**
 * Generate summary using Gemini API
 */
async function generateGeminiSummary(cleanedText, geminiApiKey) {
  if (!cleanedText || cleanedText.length < 50) {
    return 'Unable to determine services';
  }
  
  if (!geminiApiKey) {
    return 'Gemini API key not provided';
  }
  
  try {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `Based on the following website text, provide a brief 1-2 sentence summary of what services or products this company primarily offers. Focus only on their main business, not side offerings. Be concise and professional.

Website text:
${cleanedText}

Summary (1-2 sentences only):`;
    
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Clean up response - remove quotes or extra formatting
    let summary = responseText.trim();
    summary = summary.replace(/^["']|["']$/g, '');
    
    // Cap at 300 characters
    if (summary.length > 300) {
      summary = summary.substring(0, 300).trim() + '...';
    }
    
    return summary;
  } catch (error) {
    console.error('Gemini API error:', error.message);
    return 'Unable to generate summary';
  }
}

/**
 * Extract a brief summary of company services from content
 */
async function extractServicesSummary(pages, geminiApiKey) {
  // Prioritize About Us, then Services, then Homepage
  const textToAnalyze = pages.about || pages.services || pages.homepage || '';
  
  if (!textToAnalyze) return 'Unable to determine services';
  
  // Clean the text first (remove nav, social, junk)
  const cleanedText = cleanPageText(textToAnalyze);
  
  // Use Gemini to generate summary
  const summary = await generateGeminiSummary(cleanedText, geminiApiKey);
  
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
    // Only count "design" if clearly architecture-related
    domainWeight += 10;
  }
  
  return domainWeight;
}

/**
 * Identify primary service and match against 4 target categories
 */
async function analyzeServiceFit(pages, company, url, geminiApiKey) {
  // pages = { homepage: text, about: text, services: text }
  
  let scores = {
    windowCoverings: { matches: 0, weight: 0 },
    homeAutomation: { matches: 0, weight: 0 },
    architecture: { matches: 0, weight: 0 },
    interiorDesign: { matches: 0, weight: 0 },
    irrelevant: { matches: 0, weight: 0 },
  };

  // Add domain-based weight for architecture-related domains
  const domainWeight = getDomainWeight(url);
  if (domainWeight > 0) {
    scores.architecture.weight += domainWeight;
    scores.architecture.matches += 0; // Not a real match, just domain signal
  }

  let matchLog = [];
  let primaryServiceCategory = null;
  let primaryServiceKeyword = null;
  let servicesSummary = await extractServicesSummary(pages, geminiApiKey);

  // Process each page with different weights
  const pageWeights = {
    homepage: 1.0,      // Baseline
    about: 2.5,         // About pages usually state primary service
    services: 3.0,      // Services page is most authoritative for what they do
  };

  Object.entries(pages).forEach(([pageType, text]) => {
    if (!text) return;

    const lowerText = text.toLowerCase();
    const pageWeight = pageWeights[pageType] || 1.0;

    // Extract first 1000 chars (usually where primary service is mentioned)
    const primarySection = text.substring(0, 1000).toLowerCase();

    // Score each category
    Object.entries(KEYWORDS).forEach(([category, keywords]) => {
      keywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        const matches = lowerText.match(regex) || [];
        
        if (matches.length > 0) {
          // Position weighting: keywords in first 1000 chars get 3x multiplier
          // This identifies what they emphasize as primary service
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

          // Track highest scoring service in primary section (likely primary service)
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

  // Normalize weighted scores
  Object.keys(scores).forEach(key => {
    scores[key].weight = Math.round(scores[key].weight * 10) / 10;
  });

  // Determine recommendation based on PRIMARY service
  let recommendation = 'SKIP';
  let confidence = 'low';
  let reasoning = '';
  let targetCategoryMatch = null;

  const targetCategories = ['windowCoverings', 'homeAutomation', 'architecture', 'interiorDesign'];
  
  // If irrelevant keywords dominate, they're clearly not a fit
  if (scores.irrelevant.weight > (scores.windowCoverings.weight + scores.homeAutomation.weight + scores.architecture.weight + scores.interiorDesign.weight)) {
    recommendation = 'SKIP';
    confidence = 'high';
    reasoning = `Primary service appears to be: ${primaryServiceKeyword || 'other'}. Not a fit for BCC (${primaryServiceCategory || 'irrelevant industry'}).`;
  }
  // If one of our 4 target categories clearly dominates
  else if (primaryServiceCategory && targetCategories.includes(primaryServiceCategory)) {
    targetCategoryMatch = primaryServiceCategory;
    
    if (scores[primaryServiceCategory].weight >= 30) {
      recommendation = 'KEEP';
      confidence = 'high';
      reasoning = `Primary service is ${primaryServiceCategory}: ${primaryServiceKeyword}. Strong fit for BCC.`;
    } else if (scores[primaryServiceCategory].weight >= 15) {
      recommendation = 'KEEP';
      confidence = 'medium';
      reasoning = `Primary service appears to be ${primaryServiceCategory}: ${primaryServiceKeyword}. Good fit for BCC.`;
    } else {
      recommendation = 'MAYBE';
      confidence = 'low';
      reasoning = `Offers ${primaryServiceCategory} services but signals are weak. Manual review recommended.`;
    }
  }
  // Ambiguous: signals are mixed or unclear
  else if ((scores.windowCoverings.weight + scores.homeAutomation.weight + scores.architecture.weight + scores.interiorDesign.weight) > 5) {
    recommendation = 'MAYBE';
    confidence = 'medium';
    reasoning = `Services are unclear or mixed. Could be relevant. Manual review recommended.`;
  }
  // No strong signals either way
  else {
    recommendation = 'SKIP';
    confidence = 'medium';
    reasoning = `No clear service match found. Does not appear to work with target categories.`;
  }

  return {
    recommendation,
    confidence,
    primaryServiceIdentified: primaryServiceCategory ? `${primaryServiceCategory}: ${primaryServiceKeyword}` : 'Unclear',
    targetCategoryMatch: targetCategoryMatch || 'None',
    servicesSummary,
    reasoning,
    scores: {
      windowCoverings: scores.windowCoverings.weight,
      homeAutomation: scores.homeAutomation.weight,
      architecture: scores.architecture.weight,
      interiorDesign: scores.interiorDesign.weight,
      irrelevant: scores.irrelevant.weight,
    },
    matchLog, // Full detail for understanding decisions
  };
}

/**
 * Main actor logic
 */
Apify.main(async () => {
  const input = await Apify.getInput();
  console.log('Input:', JSON.stringify(input, null, 2));

  // Get URLs and Gemini API key from input
  const urls = input?.urls || [];
  const geminiApiKey = input?.geminiApiKey || process.env.GEMINI_API_KEY;
  
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('No URLs provided. Input should contain "urls" array.');
  }
  
  if (!geminiApiKey) {
    console.warn('⚠️  WARNING: No Gemini API key provided. Summaries will be limited.');
  }

  // Open datasets to push results
  const dataset = await Apify.openDataset('results');
  const detailDataset = await Apify.openDataset('detail-logs');

  let processedCount = 0;

  // Process each URL
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);

    try {
      // Fetch homepage
      console.log('  → Fetching homepage...');
      const homepageText = await extractPageContent(url, 'homepage');
      
      if (!homepageText) {
        throw new Error('Could not fetch homepage');
      }

      // Intelligently fetch About Us page
      let aboutText = null;
      const aboutUrl = await fetchAboutPage(url);
      if (aboutUrl) {
        console.log(`  → Found About page, fetching: ${aboutUrl}`);
        aboutText = await extractPageContent(aboutUrl, 'about');
      } else {
        console.log('  → No About page found');
      }

      // Intelligently fetch Services page
      let servicesText = null;
      const servicesUrl = await fetchServicesPage(url);
      if (servicesUrl) {
        console.log(`  → Found Services page, fetching: ${servicesUrl}`);
        servicesText = await extractPageContent(servicesUrl, 'services');
      } else {
        console.log('  → No Services page found');
      }

      // Analyze what their primary service is and if it fits BCC
      const pages = {
        homepage: homepageText,
        about: aboutText,
        services: servicesText,
      };

      const analysis = await analyzeServiceFit(pages, url.split('/')[2], url, geminiApiKey);

      // Main result - columns for CSV
      const result = {
        url,
        status: 'success',
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        servicesSummary: analysis.servicesSummary,
        primaryServiceIdentified: analysis.primaryServiceIdentified,
        targetCategoryMatch: analysis.targetCategoryMatch,
        reasoning: analysis.reasoning,
        windowCoveringsScore: analysis.scores.windowCoverings,
        homeAutomationScore: analysis.scores.homeAutomation,
        architectureScore: analysis.scores.architecture,
        interiorDesignScore: analysis.scores.interiorDesign,
        irrelevantScore: analysis.scores.irrelevant,
        pagesAnalyzed: {
          homepage: !!homepageText,
          about: !!aboutText,
          services: !!servicesText,
        },
        timestamp: new Date(),
      };

      await dataset.pushData(result);

      // Detailed logs for iteration
      const detailLog = {
        url,
        recommendation: analysis.recommendation,
        primaryServiceIdentified: analysis.primaryServiceIdentified,
        matchDetails: analysis.matchLog,
        totalMatches: analysis.matchLog.length,
        timestamp: new Date(),
      };

      await detailDataset.pushData(detailLog);

      processedCount++;
      console.log(`  ✅ ${analysis.recommendation}`);

    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      
      await dataset.pushData({
        url,
        status: 'error',
        error: error.message,
        timestamp: new Date(),
      });
    }

    // Delay to avoid overwhelming servers
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  console.log(`\n✅ Completed analysis of ${processedCount}/${urls.length} URLs`);
  console.log(`Results saved to 'results' dataset`);
  console.log(`Detailed match logs saved to 'detail-logs' dataset`);
});
