'use strict';
/* Private reflective text analysis — transparent, negation-aware local NLP.
   Produces personal insights for mindset, feelings,
   topics, time orientation, senses, and pronoun usage. */

const LISTS = {
  introvert: ['i','me','my','mine','myself',"i'm","i've","i'll","i'd"],
  extrovert: ['we','us','our','ours','they','them','their','theirs','friend','friends','people','everyone','together','party','talk','talked','talking','meet','met','group','team','someone','anybody','everybody'],
  positive: ['love','loved','great','good','happy','joy','amazing','wonderful','excited','grateful','thankful','best','awesome','excellent','beautiful','glad','proud','hope','hopeful','win','won','success','enjoy','enjoyed','laugh','laughed','smile','smiled','peace','calm','brilliant','fantastic','perfect','pleased','delight','blessed','nice','fun','yes','like','liked','better','celebrate','celebrated','achieved','accomplished','kind','gratitude','optimistic','exciting','favorite','favourite','lovely','strong','confident','relaxed','refreshed','inspired','motivated'],
  negative: ['sad','bad','hate','hated','angry','anger','upset','terrible','awful','worst','fail','failed','failure','fear','afraid','scared','worried','worry','anxious','anxiety','stress','stressed','tired','exhausted','lonely','hurt','pain','painful','cry','cried','tears','depressed','depression','miserable','broken','lost','miss','missed','regret','guilt','ashamed','shame','disappointed','disappointment','annoyed','frustrated','frustration','horrible','suck','sucks','never','nothing','cant',"can't",'problem','problems','hard','difficult','struggle','struggling','overwhelmed','bored','boring','annoying','worse'],
  uncertain: ['maybe','might','perhaps','possibly','probably','guess','seems','unsure','doubt','confused','confusion','wonder','wondering','somehow','apparently','allegedly','unclear','whether','if','could','would','should','hopefully','luck','lucky','chance','unknown'],
  certain: ['definitely','absolutely','certainly','surely','know','known','clearly','obviously','always','must','will','fact','facts','truth','sure','exactly','precisely','certain','convinced'],
  thinking: ['think','thought','thoughts','know','consider','analyzed','analyze','reason','reasons','logical','logic','because','therefore','however','realize','realized','understand','understood','believe','question','questions','evaluate','concluded','conclude','decide','decided','plan','planned','strategy','objective','practical','rational','sensible','smart','figure','figured','realizing','considering'],
  feeling: ['feel','felt','feeling','feelings','emotion','emotional','heart','care','caring','warmth','tender','compassion','empathy','ache','sensitive','moved','touched','soul','passion','passionate','instinct','gut']
};

const FEELINGS = [
  { emoji: '😔', label: 'Sad',       color: '#1f3a5f', words: ['sad','unhappy','depressed','gloomy','miserable','down','sorrow','grief','cry','cried','tears','lonely','heartbroken','hurt','empty','hopeless','disappointed'] },
  { emoji: '😄', label: 'Happy',     color: '#f4b400', words: ['happy','joy','joyful','glad','cheerful','delighted','smile','smiled','laugh','laughed','fun','excited','thrilled','pleased','great','wonderful','amazing','awesome','celebrating'] },
  { emoji: '😠', label: 'Angry',     color: '#c0392b', words: ['angry','mad','furious','rage','annoyed','irritated','frustrated','upset','hate','hated','bitter','resentful','pissed'] },
  { emoji: '😨', label: 'Fearful',   color: '#6b7280', words: ['afraid','scared','fear','terrified','anxious','anxiety','nervous','worried','worry','panic','dread','uneasy','insecure'] },
  { emoji: '😴', label: 'Tired',     color: '#8b7355', words: ['tired','exhausted','sleepy','drained','weary','fatigued','burnout','sluggish','nap','worn'] },
  { emoji: '😌', label: 'Calm',      color: '#45b39d', words: ['calm','peaceful','content','relaxed','serene','still','quiet','centered','grounded','chill','fine','okay','ok'] },
  { emoji: '😍', label: 'Love',      color: '#e91e63', words: ['love','loved','loving','adore','adored','cherished','affection','crush','sweet','beloved','romantic','kiss','hug','grateful','thankful'] },
  { emoji: '😲', label: 'Surprised', color: '#9b59b6', words: ['surprised','shocked','amazed','stunned','astonished','unexpected','suddenly','wow','unbelievable','startled'] },
  { emoji: '😤', label: 'Stressed',  color: '#d35400', words: ['stressed','stress','overwhelmed','pressure','deadline','rushing','rushed','busy','hectic','tense','behind','burden','juggling'] },
  { emoji: '🤞', label: 'Hopeful',   color: '#2e86c1', words: ['hope','hopeful','optimistic','confident','motivated','inspired','determined','ready','eager','ambitious','dream','dreaming'] }
];

const TOPICS = [
  { emoji: '🏆', label: 'Duty & work', color: '#16a085', words: ['work','duty','shift','roster','posting','deployment','training','job','career','success','business','project','projects','goal','goals','achieve','achievement','promotion','deadline','meeting','boss','office','professional','productivity','productive','client','milestone','finished','shipped'] },
  { emoji: '❤️', label: 'Relationships', color: '#e74c3c', words: ['family','mom','dad','mother','father','sister','brother','wife','husband','partner','boyfriend','girlfriend','friend','friends','relationship','marriage','kids','children','parents','date','dinner','together','called','texted'] },
  { emoji: '🎓', label: 'Learning',  color: '#8e44ad', words: ['school','class','learn','learning','study','studying','exam','exams','test','college','university','teacher','course','book','books','read','reading','lecture','notes','assignment','homework','semester','research','practiced','tutorial'] },
  { emoji: '💪', label: 'Health',    color: '#27ae60', words: ['health','body','exercise','gym','workout','run','running','walk','walking','sleep','diet','weight','doctor','sick','food','eating','yoga','stretch','hydrated','water','energy','fitness','steps','meal','breakfast','lunch'] },
  { emoji: '🎨', label: 'Creativity',color: '#f39c12', words: ['art','creative','write','writing','wrote','music','draw','drawing','paint','painting','design','idea','ideas','story','novel','blog','song','guitar','poem','imagine','imagination','brainstorm','sketch'] },
  { emoji: '✈️', label: 'Adventure', color: '#2980b9', words: ['travel','trip','vacation','adventure','explore','journey','flight','holiday','beach','mountains','city','visit','tour','hiking','camping','festival','concert','weekend'] },
  { emoji: '⚙️', label: 'Technology',color: '#5d6d7e', words: ['computer','code','coding','app','website','software','phone','internet','tech','ai','programming','bug','deploy','server','laptop','screen','email','keyboard','game','games','video'] },
  { emoji: '🧘', label: 'Self',      color: '#7f8c8d', words: ['myself','habit','habits','routine','meditation','meditate','journal','journaling','growth','dreams','reflection','mind','mental','therapy','values','purpose','identity','reflect','mindful','gratitude','alone'] },
  { emoji: '💰', label: 'Money',     color: '#b7950b', words: ['money','budget','bills','debt','savings','save','spend','spending','buy','bought','expensive','cheap','pay','payment','bank','salary','income','rent','price','cost','shopping','ordered','subscription'] }
];

const TIME = [
  { label: 'The Past',    color: '#7d6b9e', words: ['was','were','had','did','went','got','made','saw','came','took','said','told','knew','used','ago','yesterday','remembered','remember','then','before','earlier','once','previously','recalled','felt'] },
  { label: 'The Present', color: '#5dade2', words: ['is','are','am','now','today','currently','being','this','tonight','presently','feeling','feel','feels','trying','working'] },
  { label: 'The Future',  color: '#58d68d', words: ['will','gonna','shall','soon','tomorrow','next','planning','someday','eventually','later','upcoming','intend','future','aspire'] }
];

const SENSES = [
  { emoji: '👀', label: 'Seeing',  color: '#5dade2', words: ['see','saw','look','looked','watch','watched','noticed','observe','observed','glance','stare','stared','vision','bright','dark','color','colors','image','picture','photo','seen','view','screen'] },
  { emoji: '👂', label: 'Hearing', color: '#48c9b0', words: ['hear','heard','listen','listened','sound','sounds','noise','loud','quiet','music','voice','said','says','tell','told','speak','spoke','conversation','ring','bang','scream','whisper','song','singing'] },
  { emoji: '✋', label: 'Touching',color: '#f5b041', words: ['touch','touched','feel','felt','rough','smooth','soft','hard','warm','cold','hot','grip','hold','held','texture','pain','ache','sore','tight','pressure','hands','skin','shiver'] },
  { emoji: '👃', label: 'Smell/Taste', color: '#bb8fce', words: ['smell','smelled','scent','aroma','stink','fragrance','taste','tasted','sweet','sour','bitter','salty','delicious','flavor','coffee','tea','meal','spicy','fresh','cooking'] }
];

const PRONOUNS = [
  { label: 'I',    color: '#e74c3c', words: ['i','me','my','mine','myself',"i'm","i've","i'll","i'd"] },
  { label: 'You',  color: '#f39c12', words: ['you','your','yours','yourself','u'] },
  { label: 'We',   color: '#2ecc71', words: ['we','us','our','ours','ourselves'] },
  { label: 'They', color: '#9b59b6', words: ['they','them','their','theirs','themselves'] }
];

// Common Roman-Hindi/Hinglish words are normalized before analysis. This is
// intentionally transparent keyword analysis, not a diagnosis or AI therapist.
const HINGLISH = {
  main: 'i', mai: 'i', mujhe: 'me', mujhai: 'me', mera: 'my', meri: 'my', mere: 'my', hum: 'we', ham: 'we',
  hamara: 'our', apna: 'my', dost: 'friend', doston: 'friends', log: 'people', sab: 'everyone',
  khush: 'happy', khushi: 'happy', accha: 'good', acha: 'good', achha: 'good', badhiya: 'great', pyar: 'love',
  pyaar: 'love', umeed: 'hope', jeet: 'win', safalta: 'success', kamyabi: 'success', shant: 'calm',
  dukhi: 'sad', udaas: 'sad', udas: 'sad', gussa: 'angry', naraz: 'angry', darr: 'fear', dar: 'fear',
  chinta: 'worry', pareshan: 'worried', tension: 'stress', thaka: 'tired', thaki: 'tired', thakaan: 'tired',
  akela: 'lonely', dard: 'pain', mushkil: 'difficult', pareshaani: 'problem', dikkat: 'problem',
  soch: 'think', sochna: 'think', socha: 'thought', samajh: 'understand', pata: 'know', yakin: 'certain',
  shayad: 'maybe', lagta: 'seems', mehsoos: 'feel', dil: 'heart', jazbaat: 'emotion',
  parivar: 'family', pariwar: 'family', ghar: 'home', naukri: 'work', kaam: 'work', duty: 'duty',
  neend: 'sleep', sona: 'sleep', sehat: 'health', paisa: 'money', paise: 'money',
  kal: 'tomorrow', aaj: 'today', abhi: 'now', baad: 'later', pehle: 'before', bhavishya: 'future',
  dekha: 'saw', dekh: 'see', suna: 'heard', sun: 'hear', bola: 'said', haath: 'hands'
};

// Small, intentionally transparent Hindi normalization set. It is not a
// language model: it simply prevents Devanagari voice transcripts from being
// discarded and gives common reflective words the same treatment as their
// English/Hinglish equivalents.
const HINDI = {
  'मैं': 'i', 'मुझे': 'me', 'मेरा': 'my', 'मेरी': 'my', 'मेरे': 'my', 'हम': 'we', 'हमारा': 'our',
  'खुश': 'happy', 'खुशी': 'happy', 'अच्छा': 'good', 'बढ़िया': 'great', 'प्यार': 'love', 'उम्मीद': 'hope', 'शांत': 'calm',
  'उदास': 'sad', 'गुस्सा': 'angry', 'डर': 'fear', 'चिंता': 'worry', 'परेशान': 'worried', 'तनाव': 'stress',
  'थका': 'tired', 'थकी': 'tired', 'थकान': 'tired', 'अकेला': 'lonely', 'दर्द': 'pain', 'मुश्किल': 'difficult',
  'सोच': 'think', 'समझ': 'understand', 'महसूस': 'feel', 'दिल': 'heart', 'परिवार': 'family', 'घर': 'home',
  'काम': 'work', 'ड्यूटी': 'duty', 'नींद': 'sleep', 'सेहत': 'health', 'आज': 'today', 'कल': 'tomorrow', 'अभी': 'now'
};
function tokenize(text) {
  // Preserve Unicode combining marks as well as letters. Devanagari vowels
  // are often encoded as marks; dropping them turns words such as “ड्यूटी”
  // into fragments that can never match the transparent Hindi dictionary.
  return (text || '').toLowerCase().replace(/[^\p{L}\p{M}'\s]/gu, ' ').split(/\s+/).filter(Boolean)
    .map(t => HINDI[t] || HINGLISH[t] || t);
}

// Negations flip the meaning of the words that follow them ("not angry" is
// not an anger signal). Each negator scopes over the next two words.
const NEGATORS = new Set(['not','no','never','none','cannot','cant',"can't",'dont',"don't",'didnt',"didn't",'doesnt',"doesn't",'isnt',"isn't",'wasnt',"wasn't",'arent',"aren't",'werent',"weren't",'without','hardly','barely','nahi','nahin','नहीं','मत']);

/** Pair every token with whether a recent negator scopes over it. */
function tagNegations(tokens) {
  let scope = 0;
  const tagged = tokens.map(token => {
    const negated = scope > 0;
    scope = scope > 0 ? scope - 1 : 0;
    if (NEGATORS.has(token)) scope = 2;
    return { token, negated };
  });
  // Hindi/Hinglish commonly places the negator after its target: “gussa
  // bilkul nahi” / “गुस्सा नहीं”. Mark up to two preceding tokens too.
  for (let index = 1; index < tagged.length; index++) {
    if (!NEGATORS.has(tagged[index].token)) continue;
    tagged[index - 1].negated = true;
    if (index > 1) tagged[index - 2].negated = true;
  }
  return tagged;
}

function tally(tagged, words) {
  const set = new Set(words);
  let n = 0;
  for (const item of tagged) if (!item.negated && set.has(item.token)) n++;
  return n;
}

function analyze(text) {
  const tagged = tagNegations(tokenize(text));
  const c = {};
  for (const [k, words] of Object.entries(LISTS)) c[k] = tally(tagged, words);
  const pct = (a, b) => { const s = a + b; return s === 0 ? 50 : Math.round((a / s) * 100); };
  const mindset = {
    introvert: pct(c.introvert, c.extrovert),
    positive: pct(c.positive, c.negative),
    certain: pct(c.certain, c.uncertain),
    thinking: pct(c.thinking, c.feeling),
    counts: c, totalWords: tagged.length
  };
  const pick = arr => arr.map(g => ({ emoji: g.emoji || '', label: g.label, color: g.color, count: tally(tagged, g.words) }))
    .sort((x, y) => y.count - x.count);
  return {
    mindset,
    feelings: pick(FEELINGS),
    topics: pick(TOPICS),
    time: pick(TIME),
    senses: pick(SENSES),
    pronouns: pick(PRONOUNS),
    meta: {
      method: 'Transparent local keyword counts (negation-aware)',
      experimental: true,
      diagnosis: false,
      privacy: 'Computed for the journal owner only; never used for organizational prediction.'
    }
  };
}

/* speed stats from a timeline of [secondsElapsed, wordCount] samples */
function speedStats(timeline, words, timeSec) {
  const tl = Array.isArray(timeline) ? timeline.filter(p => Array.isArray(p) && p.length >= 2) : [];
  let distractions = 0, minutesToGoal = null;
  for (let i = 1; i < tl.length; i++) if (tl[i][1] < tl[i - 1][1]) distractions++;
  for (const [s, w] of tl) if (w >= 150) { minutesToGoal = +(s / 60).toFixed(1); break; }
  const minutes = Math.max(timeSec || 0, tl.length ? tl[tl.length - 1][0] : 0) / 60;
  const wpm = minutes > 0.2 ? Math.round((words || 0) / minutes) : 0;
  return { distractions, minutesToGoal, wpm, minutes: +minutes.toFixed(1) };
}

module.exports = { analyze, speedStats };


