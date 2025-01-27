import { supabase } from '../lib/supabase';
import { journalPrompts } from '../config/prompts';
import type { JournalEntry } from '../types';

// NLP helper functions
function extractEmotionalThemes(text: string): string[] {
  const emotionalKeywords = {
    joy: ['happy', 'excited', 'grateful', 'love', 'wonderful', 'amazing', 'delighted'],
    sadness: ['sad', 'disappointed', 'hurt', 'lonely', 'depressed', 'down'],
    anger: ['angry', 'frustrated', 'annoyed', 'upset', 'irritated'],
    fear: ['afraid', 'worried', 'anxious', 'nervous', 'scared'],
    hope: ['hopeful', 'optimistic', 'looking forward', 'excited about', 'confident'],
    growth: ['learning', 'improving', 'growing', 'developing', 'progress', 'better']
  };

  const themes = new Set<string>();
  const lowercaseText = text.toLowerCase();

  Object.entries(emotionalKeywords).forEach(([theme, keywords]) => {
    if (keywords.some(keyword => lowercaseText.includes(keyword))) {
      themes.add(theme);
    }
  });

  return Array.from(themes);
}

function extractKeyTopics(text: string): string[] {
  const topics = new Set<string>();
  const sentences = text.split(/[.!?]+/).filter(Boolean);

  const topicPatterns = {
    reflection: ['think', 'reflect', 'realize', 'understand', 'wonder'],
    emotion: ['feel', 'emotion', 'mood', 'heart'],
    growth: ['learn', 'grow', 'improve', 'change', 'better'],
    goals: ['want', 'goal', 'plan', 'future', 'hope'],
    relationships: ['friend', 'family', 'relationship', 'people'],
    challenges: ['difficult', 'challenge', 'hard', 'struggle'],
    gratitude: ['grateful', 'thankful', 'appreciate', 'blessed'],
    mindfulness: ['present', 'moment', 'aware', 'notice', 'mindful']
  };

  sentences.forEach(sentence => {
    const lowercaseSentence = sentence.toLowerCase().trim();
    Object.entries(topicPatterns).forEach(([topic, patterns]) => {
      if (patterns.some(pattern => lowercaseSentence.includes(pattern))) {
        topics.add(topic);
      }
    });
  });

  return Array.from(topics);
}

function analyzeSentiment(text: string): Record<string, number> {
  const sentiments = {
    positive: 0,
    negative: 0,
    neutral: 0,
    intensity: 0
  };

  const positiveWords = [
    'good', 'great', 'happy', 'excited', 'love', 'wonderful', 'amazing',
    'grateful', 'thankful', 'blessed', 'joy', 'delighted', 'peaceful'
  ];
  
  const negativeWords = [
    'bad', 'sad', 'angry', 'upset', 'hate', 'terrible', 'awful',
    'disappointed', 'frustrated', 'worried', 'anxious', 'stressed'
  ];

  const intensifiers = [
    'very', 'really', 'extremely', 'absolutely', 'totally', 'completely',
    'deeply', 'strongly', 'highly', 'incredibly'
  ];

  const words = text.toLowerCase().split(/\s+/);
  let hasIntensifier = false;

  words.forEach(word => {
    if (intensifiers.includes(word)) {
      hasIntensifier = true;
      sentiments.intensity++;
    } else {
      const multiplier = hasIntensifier ? 2 : 1;
      if (positiveWords.includes(word)) {
        sentiments.positive += multiplier;
      } else if (negativeWords.includes(word)) {
        sentiments.negative += multiplier;
      } else {
        sentiments.neutral++;
      }
      hasIntensifier = false;
    }
  });

  return sentiments;
}

// Export the NLP functions for use in other services
export { extractEmotionalThemes, extractKeyTopics, analyzeSentiment };

export async function getJournalStats(userId: string) {
  try {
    // Get user stats first
    const { data: stats, error: statsError } = await supabase
      .from('user_stats')
      .select('total_entries, last_entry_date')
      .eq('user_id', userId)
      .single();

    if (statsError) {
      console.error('Error fetching user stats:', statsError);
      // If we can't get stats, fall back to calculating from entries
      const { data: entries, error: entriesError } = await supabase
        .from('journal_entries')
        .select('created_at')
        .eq('user_id', userId)
        .eq('completed', true)
        .order('created_at', { ascending: false });

      if (entriesError) throw entriesError;

      // Count unique dates
      const uniqueDates = new Set(
        entries?.map(entry => new Date(entry.created_at).toISOString().split('T')[0]) || []
      );

      // Get last entry date (will be null if no entries)
      const lastEntryDate = entries && entries.length > 0 ? entries[0].created_at : null;

      return {
        totalEntries: uniqueDates.size,
        lastEntryDate
      };
    }

    // Return stats from the user_stats table
    return {
      totalEntries: stats.total_entries || 0,
      lastEntryDate: stats.last_entry_date
    };
  } catch (error) {
    console.error('Error in getJournalStats:', error);
    // Return safe defaults if everything fails
    return {
      totalEntries: 0,
      lastEntryDate: null
    };
  }
}

export async function canSubmitJournalToday(userId: string): Promise<boolean> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    // Check if there's already a completed journal for today
    const { data: completedEntries, error: completedError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('created_at', startOfDay.toISOString())
      .limit(1);

    if (completedError) throw completedError;
    if (completedEntries?.length > 0) return false;

    // Check number of prompts answered today
    const { data: todayEntries, error: entriesError } = await supabase
      .from('journal_entries')
      .select('prompt')
      .eq('user_id', userId)
      .gte('created_at', startOfDay.toISOString());

    if (entriesError) throw entriesError;

    const answeredPrompts = new Set(todayEntries?.map(entry => entry.prompt) || []);
    return answeredPrompts.size < journalPrompts.length;
  } catch (error) {
    console.error('Error checking journal submission:', error);
    return true; // Default to allowing submission if there's an error
  }
}

export async function completeJournal(userId: string): Promise<void> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    // Get today's entries
    const { data: todayEntries, error: entriesError } = await supabase
      .from('journal_entries')
      .select('id, prompt')
      .eq('user_id', userId)
      .gte('created_at', startOfDay.toISOString());

    if (entriesError) throw entriesError;

    // Verify all prompts are answered
    if (!todayEntries || todayEntries.length < journalPrompts.length) {
      throw new Error('Please answer all journal prompts before completing');
    }

    const answeredPrompts = new Set(todayEntries.map(entry => entry.prompt));
    const allPromptsAnswered = journalPrompts.every(prompt => 
      answeredPrompts.has(prompt.question)
    );

    if (!allPromptsAnswered) {
      throw new Error('Please answer all journal prompts before completing');
    }

    // Mark all entries as completed
    const { error: updateError } = await supabase
      .from('journal_entries')
      .update({ completed: true })
      .in('id', todayEntries.map(entry => entry.id));

    if (updateError) throw updateError;

    // Update user stats
    await getJournalStats(userId);
  } catch (error) {
    console.error('Error completing journal:', error);
    throw error;
  }
}

export async function saveJournalEntry(
  userId: string,
  prompt: string,
  answer: string,
  aiResponse: string
): Promise<JournalEntry> {
  try {
    // Extract metadata
    const metadata = {
      emotional_themes: extractEmotionalThemes(answer),
      key_topics: extractKeyTopics(answer),
      word_count: answer.split(/\s+/).length,
      timestamp: new Date().toISOString(),
      prompt_category: categorizePrompt(prompt),
      sentiment_indicators: analyzeSentiment(answer)
    };

    // Save the entry
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .insert([{
        user_id: userId,
        prompt,
        answer,
        ai_response: aiResponse,
        metadata,
        completed: false
      }])
      .select()
      .single();

    if (entryError) throw entryError;
    return entry;
  } catch (error) {
    console.error('Error in saveJournalEntry:', error);
    throw error;
  }
}

export async function getJournalHistory(userId: string): Promise<JournalEntry[]> {
  try {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error getting journal history:', error);
    throw error;
  }
}

function categorizePrompt(prompt: string): string {
  const categories = {
    reflection: ['reflect', 'think about', 'remember', 'recall'],
    emotion: ['feel', 'emotion', 'mood', 'happy', 'sad'],
    growth: ['learn', 'improve', 'grow', 'change', 'goal'],
    gratitude: ['grateful', 'thankful', 'appreciate'],
    challenge: ['challenge', 'difficult', 'overcome', 'struggle']
  };

  const lowercasePrompt = prompt.toLowerCase();
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.some(keyword => lowercasePrompt.includes(keyword))) {
      return category;
    }
  }

  return 'general';
}