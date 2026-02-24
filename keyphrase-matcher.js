const natural = require('natural');
const stringSimilarity = require('string-similarity');

// Russian text processing setup
const stemmer = natural.PorterStemmerRu.stem;
const tokenizer = new natural.RegexpTokenizer({ pattern: /[^А-Яа-яЁё]+/gi });

function normalizeRussian(text) {
    return text
        .toLowerCase()
        .replace(/ё/g, 'е')          // Normalize ё to е
        .replace(/[ъь]/g, '')        // Remove hard/soft signs
        .normalize('NFKC')           // Normalize unicode characters
        .replace(/[^а-яе]+/g, ' ')   // Remove non-Cyrillic characters
        .replace(/\s+/g, ' ')        // Clean extra spaces
        .trim();
}

function fuzzyMatchRussian(message, keyphrases, options = {}) {
    const {
        minSimilarity = 0.82,
        checkStemming = true
    } = options;

    // Preprocess message
    const cleanMessage = normalizeRussian(message);
    let messageTokens = tokenizer.tokenize(cleanMessage);
    
    // Apply stemming if enabled
    if (checkStemming) {
        messageTokens = messageTokens.map(token => stemmer(token));
    }

    const matches = [];

    keyphrases.forEach(phrase => {
        // Preprocess phrase
        const cleanPhrase = normalizeRussian(phrase);
        let phraseTokens = tokenizer.tokenize(cleanPhrase);
        
        // Skip empty phrases
        if (phraseTokens.length === 0) return;

        // Apply stemming to phrase
        if (checkStemming) {
            phraseTokens = phraseTokens.map(token => stemmer(token));
        }

        // Calculate word matches
        const wordMatches = phraseTokens.map(phraseWord => {
            const matches = stringSimilarity.findBestMatch(phraseWord, messageTokens);
            return matches.bestMatch.rating;
        });

        // Calculate scores
        const avgScore = wordMatches.reduce((a, b) => a + b, 0) / wordMatches.length;
        const minScore = Math.min(...wordMatches);

        // Check matching criteria
        if (avgScore >= minSimilarity && minScore >= (minSimilarity - 0.15)) {
            matches.push({
                phrase: phrase,
                score: avgScore,
                matchedWords: phraseTokens
            });
        }
    });

    return matches.sort((a, b) => b.score - a.score);
}

module.exports = {
    fuzzyMatchRussian
};