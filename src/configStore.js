const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_CONFIG = {
  prefix: '%',
  ownerIds: [],
  authorizedUserIds: [],
  botStatus: {
    type: null,
    text: null
  },
  zajil: {
    displayImagePath: null,
    menuChannelId: null,
    menuMessageId: null,
    sendButton: {
      shape: '💌 إرسال زاجل',
      style: 'primary'
    },
    embed: {
      color: '#7D4AC7',
      messageText: 'وصلتك زاجل',
      messageEmoji: '🕊️',
      replyText: 'وصلك رد على زاجلك',
      replyEmoji: '↩️',
      likeNotification: 'وصلك لايك على رسالة ارسلتها',
      replyPromptMessage: 'اكتب ردك الآن في نفس هذا الخاص. تقدر ترسل نص أو صورة أو فيديو أو GIF أو ملفات، والرد مسموح مرة واحدة فقط.'
    },
    actionButtons: {
      likeEnabled: true,
      replyEnabled: true,
      likeShape: '❤️',
      replyShape: '↩️ رد'
    },
    deliveryOptions: {
      anonymousEnabled: true,
      visibleEnabled: true
    },
    replyInputMode: 'chat',
    deliveryMode: 'choice',
    forbiddenWords: [],
    blockedUsers: [],
    log: {
      guildId: null,
      categoryId: null,
      channelId: null
    },
    stats: {
      sentByUser: {}
    },
    messages: []
  }
};

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.config = structuredClone(DEFAULT_CONFIG);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.config = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }

    return this.config;
  }

  get() {
    return this.config;
  }

  async update(mutator) {
    const result = await mutator(this.config);
    await this.save();
    return result;
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(this.filePath, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    });

    return this.writeQueue;
  }
}

function mergeConfig(defaults, value) {
  const merged = structuredClone(defaults);

  if (!value || typeof value !== 'object') return merged;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (Array.isArray(defaultValue)) {
      merged[key] = Array.isArray(value[key]) ? value[key] : defaultValue;
      continue;
    }

    if (defaultValue && typeof defaultValue === 'object') {
      merged[key] = mergeConfig(defaultValue, value[key]);
      continue;
    }

    merged[key] = value[key] ?? defaultValue;
  }

  for (const [key, customValue] of Object.entries(value)) {
    if (!(key in merged)) merged[key] = customValue;
  }

  return merged;
}

module.exports = {
  ConfigStore
};
