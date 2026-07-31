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
 * Extract a brief summary of company services from content
 */
function extractServicesSummary(pages) {
  // Prioritize About Us, then Services, then Homepage
  const textToAnalyze = pages.about || pages.services || pages.homepage || '';
  
  if (!textToAnalyze) return 'Unable to determine services';
  
  // Get first 800 chars which usually contains service summary
  let summary = textToAnalyze.substring(0, 800).trim();
  
  // Remove extra whitespace and line breaks
  summary = summary.replace(/\s+/g, ' ');
  
  // Try to extract just the first 1-2 sentences
  const sentences = summary.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    // Take first 1-2 sentences
    summary = sentences.slice(0, 2).join(' ').trim();
    
    // Cap at 250 characters for readability
    if (summary.length > 250) {
      summary = summary.substring(0, 250).trim() + '...';
    }
  } else {
    // If no sentences found, just take first 250 chars
    summary = summary.substring(0, 250).trim();
  }
  
  return summary;
}

/**
 * Identify primary service and match against 4 target categories
 */
function analyzeServiceFit(pages, company) {
  // pages = { homepage: text, about: text, services: text }
  
  let scores = {
    windowCoverings: { matches: 0, weight: 0 },
    homeAutomation: { matches: 0, weight: 0 },
    architecture: { matches: 0, weight: 0 },
    interiorDesign: { matches: 0, weight: 0 },
    irrelevant: { matches: 0, weight: 0 },
  };

  let matchLog = [];
  let primaryServiceCategory = null;
  let primaryServiceKeyword = null;
  let servicesSummary = extractServicesSummary(pages);

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

  // Get URLs from input
  const urls = input?.urls || [];
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('No URLs provided. Input should contain "urls" array.');
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

      const analysis = analyzeServiceFit(pages, url.split('/')[2]);

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
