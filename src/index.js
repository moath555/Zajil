const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  FileUploadBuilder,
  GatewayIntentBits,
  LabelBuilder,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} = require('discord.js');
const { ConfigStore } = require('./configStore');

const ROOT_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });

const DATA_DIR = path.join(ROOT_DIR, 'data');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const LOG_ICONS_DIR = path.join(ASSETS_DIR, 'log-icons');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOCK_PATH = path.join(DATA_DIR, 'zajil.lock');
const PROMPT_TIMEOUT_MS = 90_000;
const SESSION_TIMEOUT_MS = 10 * 60_000;
const EPHEMERAL = 64;
const LOG_COLORS = {
  clean: 0xffffff,
  blocked: 0xe74c3c,
  reply: 0x2ecc71,
  like: 0xff5ca8
};
const LOG_MARKS = {
  clean: '✉️',
  blocked: '✉️',
  reply: '↩️',
  like: '💗'
};
const LOG_ICON_FILES = {
  clean: 'send.png',
  blocked: 'send-blocked.png',
  reply: 'reply.png',
  like: 'like.png'
};
const ACTIVITY_TYPES = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing
};
const ACTIVITY_LABELS = {
  playing: 'يلعب',
  watching: 'يشاهد',
  listening: 'يستمع',
  competing: 'ينافس'
};
const DELIVERY_LABELS = {
  choice: 'العضو يختار مجهول أو ظاهر',
  anonymous: 'مجهول فقط',
  visible: 'ظاهر فقط'
};
const SEND_BUTTON_STYLES = {
  primary: {
    label: 'أزرق',
    description: 'لون دسكورد الأزرق',
    style: ButtonStyle.Primary
  },
  secondary: {
    label: 'رمادي شفاف',
    description: 'اللون الرمادي الشفاف',
    style: ButtonStyle.Secondary
  },
  success: {
    label: 'أخضر',
    description: 'لون أخضر',
    style: ButtonStyle.Success
  },
  danger: {
    label: 'أحمر',
    description: 'لون أحمر',
    style: ButtonStyle.Danger
  }
};
const IMAGE_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp']
]);

const store = new ConfigStore(CONFIG_PATH);
const sessions = new Map();
const pendingReplies = new Map();
const replyLocks = new Set();
const likeLocks = new Set();
const envOwnerIds = new Set(
  (process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  await store.load();
  await fs.mkdir(ASSETS_DIR, { recursive: true });

  if (envOwnerIds.size > 0) {
    await store.update((config) => {
      config.ownerIds = unique([...config.ownerIds, ...envOwnerIds]);
    });
  }

  await pruneExpiredBlocks();
  await applyStoredPresence();

  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Settings command: ${store.get().prefix}settings / ${store.get().prefix}اعدادات`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (!message.guild) {
    await handleDirectMessage(message);
    return;
  }

  const { prefix } = store.get();
  const content = message.content.trim();
  const settingsCommands = [`${prefix}settings`, `${prefix}اعدادات`];

  if (settingsCommands.includes(content)) {
    if (!(await canUseSettings(message.author.id))) {
      await message.reply('ما عندك صلاحية استخدام إعدادات البوت.');
      return;
    }

    await message.reply(settingsHomePanel());
    return;
  }

  await handleModerationCommand(message, prefix, content);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isStringSelectMenu()) {
      await handleStringSelect(interaction);
      return;
    }

    if (interaction.isUserSelectMenu()) {
      await handleUserSelect(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await deferHidden(interaction);
      await handleModal(interaction);
    }
  } catch (error) {
    console.error('[interaction] failed:', error);
    await replyHidden(interaction, 'صار خطأ. تأكد من صلاحيات البوت ثم جرب مرة ثانية.');
  }
});

async function handleStringSelect(interaction) {
  if (interaction.customId.startsWith('settings:')) {
    if (!(await canUseSettings(interaction.user.id))) {
      await replyHidden(interaction, 'ما عندك صلاحية استخدام إعدادات البوت.');
      return;
    }

    await handleSettingsSelect(interaction, interaction.values[0]);
    return;
  }

  if (interaction.customId.startsWith('zajil:mode:')) {
    await handleDeliveryModeSelect(interaction);
    return;
  }

  if (interaction.customId.startsWith('block:duration:')) {
    await handleBlockDurationSelect(interaction);
  }
}

async function handleUserSelect(interaction) {
  if (!interaction.customId.startsWith('zajil:recipient:')) return;

  const sessionId = interaction.customId.split(':').at(-1);
  const session = sessions.get(sessionId);

  if (!session || session.senderId !== interaction.user.id) {
    await replyHidden(interaction, 'انتهت عملية الإرسال. اضغط زر زاجل من جديد.');
    return;
  }

  const targetId = interaction.values[0];
  if (targetId === interaction.user.id) {
    await replyHidden(interaction, 'ما تقدر ترسل زاجل لنفسك.');
    return;
  }

  const target = await client.users.fetch(targetId).catch(() => null);
  if (!target || target.bot) {
    await replyHidden(interaction, 'اختر عضو حقيقي وليس بوت.');
    return;
  }

  session.targetId = targetId;
  await interaction.showModal(composeZajilModal(sessionId));
}

async function handleButton(interaction) {
  if (interaction.customId === 'zajil:open') {
    await startZajilFlow(interaction);
    return;
  }

  if (interaction.customId.startsWith('zajil:like:')) {
    await handleLikeButton(interaction, interaction.customId.split(':').at(-1));
    return;
  }

  if (interaction.customId.startsWith('zajil:reply:')) {
    await handleReplyButton(interaction, interaction.customId.split(':').at(-1));
    return;
  }

  if (interaction.customId.startsWith('zajil:recipient-search:')) {
    await handleRecipientSearchButton(interaction, interaction.customId.split(':').at(-1));
  }
}

async function handleModal(interaction) {
  if (interaction.customId.startsWith('modal:compose:')) {
    await handleComposeModal(interaction, interaction.customId.split(':').at(-1));
    return;
  }

  if (interaction.customId.startsWith('modal:compose-search:')) {
    await handleComposeSearchModal(interaction, interaction.customId.split(':').at(-1));
    return;
  }

  if (interaction.customId.startsWith('modal:reply:')) {
    await handleReplyModal(interaction, interaction.customId.split(':').at(-1));
    return;
  }

  if (interaction.customId.startsWith('modal:status:')) {
    await setBotStatus(interaction, interaction.customId.split(':').at(-1));
    return;
  }

  switch (interaction.customId) {
    case 'modal:prefix':
      await setPrefix(interaction);
      return;
    case 'modal:bot_name':
      await setBotName(interaction);
      return;
    case 'modal:menu_channel':
      await sendZajilMenuFromModal(interaction);
      return;
    case 'modal:send_button':
      await updateSimpleZajilSetting(interaction, 'sendButton.shape', 'تم حفظ شكل زر الإرسال.');
      return;
    case 'modal:embed_color':
      await setEmbedColor(interaction);
      return;
    case 'modal:message_format':
      await setMessageFormat(interaction);
      return;
    case 'modal:reply_format':
      await setReplyFormat(interaction);
      return;
    case 'modal:like_notification':
      await updateSimpleZajilSetting(interaction, 'embed.likeNotification', 'تم حفظ رسالة اللايك.');
      return;
    case 'modal:like_button':
      await updateSimpleZajilSetting(interaction, 'actionButtons.likeShape', 'تم حفظ شكل زر اللايك.');
      return;
    case 'modal:reply_button':
      await updateSimpleZajilSetting(interaction, 'actionButtons.replyShape', 'تم حفظ شكل زر الرد.');
      return;
    case 'modal:forbidden_words':
      await setForbiddenWords(interaction);
      return;
    default:
      await replyHidden(interaction, 'هذا النموذج قديم أو غير معروف.');
  }
}

async function handleSettingsSelect(interaction, value) {
  if (value === 'nav:home') {
    await interaction.update(settingsHomePanel());
    return;
  }

  if (value.startsWith('nav:')) {
    await interaction.update(settingsSectionPanel(value.slice(4)));
    return;
  }

  if (interaction.customId === 'settings:status') {
    await handleStatusTypeSelect(interaction, value);
    return;
  }

  if (interaction.customId === 'settings:delivery') {
    await setDeliveryMode(interaction, value);
    return;
  }

  if (interaction.customId === 'settings:toggles') {
    await toggleActionSetting(interaction, value);
    return;
  }

  if (interaction.customId === 'settings:replyInput') {
    await setReplyInputMode(interaction, value);
    return;
  }

  if (interaction.customId === 'settings:sendButtonColor') {
    await setSendButtonColor(interaction, value);
    return;
  }

  switch (value) {
    case 'action:prefix':
      await interaction.showModal(singleInputModal('modal:prefix', 'تغيير برفكس البوت', 'value', 'البرفكس الجديد', store.get().prefix, 10));
      return;
    case 'action:status':
      await interaction.update(statusTypePanel());
      return;
    case 'action:toggle_authorized':
      await promptToggleAuthorized(interaction);
      return;
    case 'action:list_authorized':
      await showAuthorizedUsers(interaction);
      return;
    case 'action:bot_name':
      await interaction.showModal(singleInputModal('modal:bot_name', 'تغيير اسم البوت', 'value', 'اسم البوت الجديد', client.user.username, 32));
      return;
    case 'action:bot_avatar':
      await promptBotImage(interaction, 'avatar');
      return;
    case 'action:bot_banner':
      await promptBotImage(interaction, 'banner');
      return;
    case 'action:display_image':
      await promptDisplayImage(interaction);
      return;
    case 'action:send_button':
      await interaction.showModal(singleInputModal('modal:send_button', 'شكل زر الإرسال', 'value', 'اكتب النص أو الإيموجي', store.get().zajil.sendButton.shape, 80));
      return;
    case 'action:send_button_color':
      await interaction.update(sendButtonColorPanel());
      return;
    case 'action:send_menu':
      await interaction.showModal(singleInputModal('modal:menu_channel', 'إرسال قائمة زاجل', 'value', 'منشن الشات أو اكتب ايديه', store.get().zajil.menuChannelId || '', 30));
      return;
    case 'action:embed_color':
      await interaction.showModal(singleInputModal('modal:embed_color', 'لون الامبيد', 'value', 'مثال: #7D4AC7', store.get().zajil.embed.color, 7));
      return;
    case 'action:message_format':
      await interaction.showModal(messageFormatModal('modal:message_format', 'رسالة زاجل', store.get().zajil.embed.messageText, store.get().zajil.embed.messageEmoji));
      return;
    case 'action:reply_format':
      await interaction.showModal(messageFormatModal('modal:reply_format', 'رسالة الرد على زاجل', store.get().zajil.embed.replyText, store.get().zajil.embed.replyEmoji));
      return;
    case 'action:reply_prompt':
      await promptTextSetting(
        interaction,
        'embed.replyPromptMessage',
        'اكتب الآن رسالة طلب الرد التي تظهر للمستلم في الخاص. تقدر تستخدم نص أو إيموجي عادي أو متحرك.',
        'تم حفظ رسالة طلب الرد.'
      );
      return;
    case 'action:like_notification':
      await promptTextSetting(
        interaction,
        'embed.likeNotification',
        'اكتب الآن رسالة اللايك التي تصل لصاحب الزاجل. تقدر تستخدم نص أو إيموجي عادي أو متحرك.',
        'تم حفظ رسالة إشعار اللايك.'
      );
      return;
    case 'action:like_button':
      await interaction.showModal(singleInputModal('modal:like_button', 'شكل زر اللايك', 'value', 'اكتب النص أو الإيموجي', store.get().zajil.actionButtons.likeShape, 80));
      return;
    case 'action:reply_button':
      await interaction.showModal(singleInputModal('modal:reply_button', 'شكل زر الرد', 'value', 'اكتب النص أو الإيموجي', store.get().zajil.actionButtons.replyShape, 80));
      return;
    case 'action:delivery_mode':
      await interaction.update(deliveryModePanel());
      return;
    case 'action:toggles':
      await interaction.update(togglesPanel());
      return;
    case 'action:reply_input_mode':
      await interaction.update(replyInputModePanel());
      return;
    case 'action:forbidden_words':
      await interaction.showModal(forbiddenWordsModal());
      return;
    case 'action:block_user':
      await promptBlockUser(interaction);
      return;
    case 'action:unblock_user':
      await promptUnblockUser(interaction);
      return;
    case 'action:list_blocks':
      await showBlockedUsers(interaction);
      return;
    case 'action:create_log':
      await createLogChannel(interaction);
      return;
    default:
      await replyHidden(interaction, 'هذا الخيار قديم أو غير معروف.');
  }
}

function settingsHomePanel() {
  return settingsPayload('إعدادات زاجل', 'اختر القسم اللي تبي تعدله من المنيو.', 'settings:main', [
    option('عام', 'البرفكس وحالة البوت', 'nav:general'),
    option('التصاريح', 'إضافة أو إزالة المصرحين وعرضهم', 'nav:access'),
    option('هوية البوت', 'اسم البوت والافتار والبنر', 'nav:profile'),
    option('زاجل - القائمة', 'صورة العرض وزر الإرسال وإرسال القائمة', 'nav:zajilMenu'),
    option('زاجل - الرسائل', 'نصوص زاجل والرد ولون الامبيد', 'nav:zajilMessages'),
    option('زاجل - الأزرار والتفاعل', 'اللايك والرد وطريقة الظهور', 'nav:zajilActions'),
    option('زاجل - الحماية واللوق', 'الكلمات الممنوعة وقناة اللوق', 'nav:zajilSecurity')
  ]);
}

function settingsSectionPanel(section, note = null) {
  const config = store.get();
  const sections = {
    general: {
      title: 'عام',
      description: `البرفكس الحالي: \`${config.prefix}\`\nالحالة: ${statusLabel(config.botStatus)}`,
      customId: 'settings:general',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('برفكس البوت', 'تغيير بادئة أوامر الإعدادات', 'action:prefix'),
        option('حالة البوت', 'اختيار نوع الحالة ثم كتابة النص', 'action:status')
      ]
    },
    access: {
      title: 'التصاريح',
      description: 'الإعدادات ما يقدر يستخدمها إلا المالك والمصرحين.',
      customId: 'settings:access',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('إضافة مصرح', 'منشن الشخص لإضافته أو إزالته إذا كان موجود', 'action:toggle_authorized'),
        option('عرض المصرحين', 'عرض قائمة الأشخاص المصرحين', 'action:list_authorized')
      ]
    },
    profile: {
      title: 'هوية البوت',
      description: 'تغيير اسم البوت أو صورته.',
      customId: 'settings:profile',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('تغيير اسم البوت', 'اكتب الاسم الجديد ويتغير مباشرة', 'action:bot_name'),
        option('تغيير افتار البوت', 'ارسل صورة الافتار الجديدة', 'action:bot_avatar'),
        option('تغيير بنر البوت', 'ارسل صورة البنر الجديدة', 'action:bot_banner')
      ]
    },
    zajilMenu: {
      title: 'زاجل - القائمة',
      description: `صورة العرض: ${config.zajil.displayImagePath ? 'محفوظة' : 'غير محددة'}\nزر الإرسال: ${config.zajil.sendButton.shape}\nلون زر الإرسال: ${sendButtonStyleLabel(config.zajil.sendButton.style)}`,
      customId: 'settings:zajilMenu',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('صورة العرض', 'ارسل الصورة التي تظهر فوق الزر', 'action:display_image'),
        option('شكل زر الإرسال', 'نص أو إيموجي عادي أو متحرك', 'action:send_button'),
        option('لون زر الإرسال', 'أزرق، رمادي شفاف، أخضر، أحمر', 'action:send_button_color'),
        option('إرسال القائمة', 'اختر الشات ثم يرسل الصورة وتحتها الزر', 'action:send_menu')
      ]
    },
    zajilMessages: {
      title: 'زاجل - الرسائل',
      description: `لون الامبيد: \`${config.zajil.embed.color}\`\nرسالة زاجل: ${config.zajil.embed.messageText} ${config.zajil.embed.messageEmoji}`,
      customId: 'settings:zajilMessages',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('لون الامبيد', 'احفظ كود لون مثل #FFFFFF', 'action:embed_color'),
        option('إيموجي ورسالة زاجل', 'النص والإيموجي قبل منشن المستلم', 'action:message_format'),
        option('رسالة وصول الرد', 'النص والإيموجي الذي يصل لصاحب الزاجل', 'action:reply_format'),
        option('رسالة طلب الرد', 'تتعدل بالكتابة في الشات وتظهر عند ضغط زر الرد', 'action:reply_prompt'),
        option('رسالة إشعار اللايك', 'تتعدل بالكتابة في الشات وتصل لصاحب الزاجل', 'action:like_notification')
      ]
    },
    zajilActions: {
      title: 'زاجل - الأزرار والتفاعل',
      description: `الإرسال كظاهر: ${enabledLabel(config.zajil.deliveryOptions.visibleEnabled)}\nالإرسال كمجهول: ${enabledLabel(config.zajil.deliveryOptions.anonymousEnabled)}\nاللايك: ${enabledLabel(config.zajil.actionButtons.likeEnabled)}\nالرد: ${enabledLabel(config.zajil.actionButtons.replyEnabled)}\nكتابة الرد: ${replyInputModeLabel(config.zajil.replyInputMode)}`,
      customId: 'settings:zajilActions',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('تفعيل / تعطيل', 'ظاهر، مجهول، رد، إعجاب', 'action:toggles'),
        option('طريقة كتابة الرد', 'اختيار نافذة أو نفس الشات الخاص', 'action:reply_input_mode'),
        option('شكل زر اللايك', 'نص أو إيموجي عادي أو متحرك', 'action:like_button'),
        option('شكل زر الرد', 'نص أو إيموجي عادي أو متحرك', 'action:reply_button')
      ]
    },
    zajilSecurity: {
      title: 'زاجل - الحماية واللوق',
      description: `الكلمات الممنوعة: ${config.zajil.forbiddenWords.length || 0}\nالمحظورون: ${activeBlocks().length}\nاللوق: ${config.zajil.log.channelId ? `<#${config.zajil.log.channelId}>` : 'غير مضاف'}`,
      customId: 'settings:zajilSecurity',
      options: [
        option('رجوع', 'العودة للقائمة الرئيسية', 'nav:home'),
        option('الكلمات الممنوعة', 'إضافة أو حذف كلمات ممنوعة من الإرسال', 'action:forbidden_words'),
        option('حظر شخص من الإرسال', 'اختيار شخص ثم تحديد مدة الحظر', 'action:block_user'),
        option('إلغاء حظر شخص', 'فك الحظر بالمنشن أو الايدي', 'action:unblock_user'),
        option('عرض المحظورين', 'عرض الأشخاص ومدة الحظر المتبقية', 'action:list_blocks'),
        option('إضافة لوق', 'إنشاء كاتاقوري وشات مخفي للوق زاجل', 'action:create_log')
      ]
    }
  };

  const data = sections[section] || sections.general;
  return settingsPayload(data.title, note ? `${note}\n\n${data.description}` : data.description, data.customId, data.options);
}

function statusTypePanel() {
  return settingsPayload('حالة البوت', 'اختر نوع الحالة، وبعدها بتفتح نافذة تكتب فيها النص.', 'settings:status', [
    option('رجوع', 'العودة لقسم عام', 'nav:general'),
    option('يلعب', 'Playing', 'status:playing'),
    option('يشاهد', 'Watching', 'status:watching'),
    option('يستمع', 'Listening', 'status:listening'),
    option('ينافس', 'Competing', 'status:competing'),
    option('حذف الحالة', 'إزالة الحالة الحالية', 'status:clear')
  ]);
}

function deliveryModePanel() {
  return settingsPayload('طريقة الظهور', 'حدد هل العضو يختار، أو تجبر الإرسال كمجهول/ظاهر.', 'settings:delivery', [
    option('رجوع', 'العودة لقسم الأزرار والتفاعل', 'nav:zajilActions'),
    option('العضو يختار', 'يعرض منيو مجهول أو ظاهر عند الإرسال', 'delivery:choice'),
    option('مجهول فقط', 'كل الزواجل ترسل بدون إظهار المرسل', 'delivery:anonymous'),
    option('ظاهر فقط', 'كل الزواجل تظهر اسم المرسل', 'delivery:visible')
  ]);
}

function togglesPanel(note = null) {
  const { actionButtons, deliveryOptions } = store.get().zajil;
  const description = note ? `${note}\n\nاختر الخيار لتغيير حالته الحالية.` : 'اختر الخيار لتغيير حالته الحالية.';
  return settingsPayload('تفعيل / تعطيل', description, 'settings:toggles', [
    option('رجوع', 'العودة لقسم الأزرار والتفاعل', 'nav:zajilActions'),
    option(`${statusCircle(deliveryOptions.visibleEnabled)} إرسال كظاهر`, toggleDescription(deliveryOptions.visibleEnabled), 'toggle:visible'),
    option(`${statusCircle(deliveryOptions.anonymousEnabled)} إرسال كمجهول`, toggleDescription(deliveryOptions.anonymousEnabled), 'toggle:anonymous'),
    option(`${statusCircle(actionButtons.replyEnabled)} زر الرد`, toggleDescription(actionButtons.replyEnabled), 'toggle:reply'),
    option(`${statusCircle(actionButtons.likeEnabled)} زر الإعجاب`, toggleDescription(actionButtons.likeEnabled), 'toggle:like')
  ]);
}

function replyInputModePanel() {
  const current = store.get().zajil.replyInputMode;
  return settingsPayload('طريقة كتابة الرد', 'اختر أين يكتب مستلم الزاجل رده.', 'settings:replyInput', [
    option('رجوع', 'العودة لقسم الأزرار والتفاعل', 'nav:zajilActions'),
    option(`${statusCircle(current === 'chat')} الرد في الشات الخاص`, 'يكتب الرد كرسالة داخل الخاص', 'reply_input:chat'),
    option(`${statusCircle(current === 'modal')} الرد بنافذة`, 'تظهر نافذة لكتابة الرد وإضافة المرفقات', 'reply_input:modal')
  ]);
}

function sendButtonColorPanel(note = null) {
  const current = sendButtonStyleKey(store.get().zajil.sendButton.style);
  const options = [
    option('رجوع', 'العودة لقسم زاجل - القائمة', 'nav:zajilMenu'),
    ...Object.entries(SEND_BUTTON_STYLES).map(([key, data]) => {
      return option(`${statusCircle(current === key)} ${data.label}`, data.description, `send_button_style:${key}`);
    })
  ];

  return settingsPayload(
    'لون زر الإرسال',
    note || 'اختر لون زر إرسال زاجل في القائمة.',
    'settings:sendButtonColor',
    options
  );
}

function settingsPayload(title, description, customId, options) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x7d4ac7);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('اختر من هنا')
    .addOptions(options);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu)]
  };
}

function option(label, description, value) {
  return {
    label: label.slice(0, 100),
    description: description?.slice(0, 100),
    value
  };
}

async function handleStatusTypeSelect(interaction, value) {
  if (value === 'nav:general') {
    await interaction.update(settingsSectionPanel('general'));
    return;
  }

  if (value === 'status:clear') {
    await store.update((config) => {
      config.botStatus = { type: null, text: null };
    });
    client.user.setPresence({ activities: [], status: 'online' });
    await interaction.update(settingsSectionPanel('general', 'تم حذف حالة البوت.'));
    return;
  }

  const type = value.replace('status:', '');
  await interaction.showModal(singleInputModal(`modal:status:${type}`, 'نص حالة البوت', 'value', 'اكتب نص الحالة', store.get().botStatus.text || '', 128));
}

async function setDeliveryMode(interaction, value) {
  if (value === 'nav:zajilActions') {
    await interaction.update(settingsSectionPanel('zajilActions'));
    return;
  }

  const mode = value.replace('delivery:', '');
  if (!['choice', 'anonymous', 'visible'].includes(mode)) {
    await replyHidden(interaction, 'طريقة الإرسال غير معروفة.');
    return;
  }

  await store.update((config) => {
    config.zajil.deliveryMode = mode;
    config.zajil.deliveryOptions.anonymousEnabled = mode !== 'visible';
    config.zajil.deliveryOptions.visibleEnabled = mode !== 'anonymous';
  });
  await interaction.update(settingsSectionPanel('zajilActions', `تم حفظ طريقة الإرسال: ${DELIVERY_LABELS[mode]}.`));
}

async function toggleActionSetting(interaction, value) {
  if (value === 'nav:zajilActions') {
    await interaction.update(settingsSectionPanel('zajilActions'));
    return;
  }

  const target = {
    'toggle:like': ['actionButtons', 'likeEnabled'],
    'toggle:reply': ['actionButtons', 'replyEnabled'],
    'toggle:visible': ['deliveryOptions', 'visibleEnabled'],
    'toggle:anonymous': ['deliveryOptions', 'anonymousEnabled']
  }[value];

  if (!target) {
    await replyHidden(interaction, 'الخيار غير معروف.');
    return;
  }

  const [group, key] = target;
  const zajil = store.get().zajil;
  if (group === 'deliveryOptions' && zajil[group][key]) {
    const otherKey = key === 'visibleEnabled' ? 'anonymousEnabled' : 'visibleEnabled';
    if (!zajil[group][otherKey]) {
      await interaction.update(togglesPanel('لا يمكن تعطيل الظاهر والمجهول معًا. فعّل النوع الثاني أولًا.'));
      return;
    }
  }

  await store.update((config) => {
    config.zajil[group][key] = !config.zajil[group][key];
  });
  await interaction.update(togglesPanel());
}

async function setReplyInputMode(interaction, value) {
  const mode = value.replace('reply_input:', '');
  if (!['chat', 'modal'].includes(mode)) {
    await replyHidden(interaction, 'طريقة الرد غير معروفة.');
    return;
  }

  await store.update((config) => {
    config.zajil.replyInputMode = mode;
  });
  await interaction.update(settingsSectionPanel('zajilActions', `تم اختيار الرد ${mode === 'chat' ? 'في الشات الخاص' : 'بنافذة'}.`));
}

async function setSendButtonColor(interaction, value) {
  const style = value.replace('send_button_style:', '');
  if (!SEND_BUTTON_STYLES[style]) {
    await replyHidden(interaction, 'لون الزر غير معروف.');
    return;
  }

  await store.update((config) => {
    config.zajil.sendButton.style = style;
  });

  await updateStoredZajilMenuButton(interaction.guild).catch((error) => console.error('[menu button style] failed:', error));
  await interaction.update(settingsSectionPanel('zajilMenu', `تم تغيير لون زر الإرسال إلى: ${SEND_BUTTON_STYLES[style].label}.`));
}

async function startZajilFlow(interaction) {
  if (!interaction.guild) {
    await replyHidden(interaction, 'زر زاجل يستخدم داخل السيرفر فقط.');
    return;
  }

  const blocked = findActiveBlock(interaction.user.id, interaction.guild.id);
  if (blocked) {
    await replyHidden(interaction, blockNotice(blocked));
    return;
  }

  const options = store.get().zajil.deliveryOptions;
  const availableModes = [
    options.anonymousEnabled ? 'anonymous' : null,
    options.visibleEnabled ? 'visible' : null
  ].filter(Boolean);

  if (availableModes.length === 1) {
    const sessionId = createSession({
      guildId: interaction.guild.id,
      senderId: interaction.user.id,
      mode: availableModes[0]
    });
    await interaction.reply(userPickerPayload(sessionId, true));
    return;
  }

  if (availableModes.length === 0) {
    await replyHidden(interaction, 'الإرسال كظاهر ومجهول معطل حاليًا.');
    return;
  }

  const sessionId = createSession({
    guildId: interaction.guild.id,
    senderId: interaction.user.id,
    mode: null
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`zajil:mode:${sessionId}`)
    .setPlaceholder('اختر نوع الإرسال')
    .addOptions([
      options.anonymousEnabled ? option('إرسال كمجهول', 'المستلم ما يعرف من المرسل', 'anonymous') : null,
      options.visibleEnabled ? option('إرسال كشخص ظاهر', 'المستلم يشوف اسمك ومنشنك', 'visible') : null
    ].filter(Boolean));

  await interaction.reply({
    content: 'اختر طريقة إرسال زاجلك.',
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: EPHEMERAL
  });
}

async function handleDeliveryModeSelect(interaction) {
  const sessionId = interaction.customId.split(':').at(-1);
  const session = sessions.get(sessionId);

  if (!session || session.senderId !== interaction.user.id) {
    await replyHidden(interaction, 'انتهت عملية الإرسال. اضغط زر زاجل من جديد.');
    return;
  }

  const mode = interaction.values[0];
  const options = store.get().zajil.deliveryOptions;
  const enabled = mode === 'anonymous' ? options.anonymousEnabled : mode === 'visible' ? options.visibleEnabled : false;

  if (!enabled) {
    await interaction.update({ content: 'نوع الإرسال هذا تم تعطيله. اضغط زر زاجل من جديد.', embeds: [], components: [] });
    sessions.delete(sessionId);
    return;
  }

  session.mode = mode;
  await interaction.update(userPickerPayload(sessionId, false));
}

async function handleRecipientSearchButton(interaction, sessionId) {
  const session = sessions.get(sessionId);

  if (!session || session.senderId !== interaction.user.id || !session.mode) {
    await replyHidden(interaction, 'انتهت عملية الإرسال. اضغط زر زاجل من جديد.');
    return;
  }

  await interaction.showModal(composeZajilSearchModal(sessionId));
}

function userPickerPayload(sessionId, ephemeral) {
  const picker = new UserSelectMenuBuilder()
    .setCustomId(`zajil:recipient:${sessionId}`)
    .setPlaceholder('اختر العضو أو ابحث عنه')
    .setMinValues(1)
    .setMaxValues(1);

  return {
    content: 'اختر عضو واحد فقط، أو استخدم زر البحث إذا تبي تكتب اليوزر أو الآيدي.',
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(picker),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`zajil:recipient-search:${sessionId}`)
          .setLabel('بحث باليوزر أو الآيدي')
          .setStyle(ButtonStyle.Secondary)
      )
    ],
    ...(ephemeral ? { flags: EPHEMERAL } : {})
  };
}

async function handleComposeModal(interaction, sessionId) {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);

  const content = interaction.fields.getTextInputValue('content').trim();
  const uploadedFiles = interaction.fields.getUploadedFiles('attachments') || new Map();
  const attachments = serializeAttachments(uploadedFiles);

  const target = session?.targetId ? await client.users.fetch(session.targetId).catch(() => null) : null;
  await submitZajil(interaction, session, target, content, attachments);
}

async function handleComposeSearchModal(interaction, sessionId) {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);

  const recipientQuery = interaction.fields.getTextInputValue('recipient').trim();
  const content = interaction.fields.getTextInputValue('content').trim();
  const uploadedFiles = interaction.fields.getUploadedFiles('attachments') || new Map();
  const attachments = serializeAttachments(uploadedFiles);

  if (!interaction.guild) {
    await replyHidden(interaction, 'البحث عن عضو يستخدم داخل السيرفر فقط.');
    return;
  }

  const result = await resolveGuildMember(interaction.guild, recipientQuery);
  if (result.ambiguous) {
    await replyHidden(interaction, 'لقيت أكثر من عضو بنفس البحث. اكتب الآيدي، أو اكتب اليوزر بشكل أدق.');
    return;
  }

  await submitZajil(interaction, session, result.member?.user || null, content, attachments);
}

async function submitZajil(interaction, session, target, content, attachments) {
  if (!session || session.senderId !== interaction.user.id || !session.mode) {
    await replyHidden(interaction, 'انتهت عملية الإرسال. اضغط زر زاجل من جديد.');
    return;
  }

  if (!target) {
    await replyHidden(interaction, 'ما قدرت ألقى العضو.');
    return;
  }

  if (target.id === interaction.user.id) {
    await replyHidden(interaction, 'ما تقدر ترسل زاجل لنفسك.');
    return;
  }

  if (target.bot) {
    await replyHidden(interaction, 'اختر عضو حقيقي وليس بوت.');
    return;
  }

  if (!content && attachments.length === 0) {
    await replyHidden(interaction, 'اكتب رسالة أو أرفق صورة أو فيديو أو ملف.');
    return;
  }

  const activeBlock = findActiveBlock(interaction.user.id, session.guildId);
  if (activeBlock) {
    await replyHidden(interaction, blockNotice(activeBlock));
    return;
  }

  const config = store.get();
  const blockedLink = findBlockedLink(content);
  if (blockedLink) {
    const count = getSentCount(interaction.user.id);
    await sendLog(session.guildId, {
      kind: 'blocked',
      title: 'محاولة إرسال رابط ممنوع',
      byId: interaction.user.id,
      toId: target.id,
      content: neutralizeLinks(content),
      count,
      mode: session.mode,
      attachments,
      extra: [{ name: 'الرابط الممنوع', value: neutralizeLinks(blockedLink) }]
    });
    await replyHidden(interaction, 'الروابط ممنوعة في زاجل. ارسل رسالتك بدون روابط.');
    return;
  }

  const blockedWord = findForbiddenWord(content, config.zajil.forbiddenWords);

  if (blockedWord) {
    const count = getSentCount(interaction.user.id);
    await sendLog(session.guildId, {
      kind: 'blocked',
      title: 'محاولة إرسال كلمة ممنوعة',
      byId: interaction.user.id,
      toId: target.id,
      content,
      count,
      mode: session.mode,
      attachments,
      extra: [{ name: 'الكلمة الممنوعة', value: blockedWord }]
    });
    await replyHidden(interaction, `رسالتك تحتوي كلام ممنوع: \`${blockedWord}\`.`);
    return;
  }

  const record = {
    id: shortId(),
    guildId: session.guildId,
    senderId: interaction.user.id,
    targetId: target.id,
    mode: session.mode,
    content,
    attachments,
    createdAt: Date.now(),
    sentCount: 0,
    likedBy: [],
    replies: [],
    replyUsed: false
  };

  const { message: dmMessage, error: dmError } = await sendDmMessage(target, buildZajilDmPayload(record, interaction.user, target), 'zajil-send');
  if (!dmMessage) {
    await replyHidden(interaction, dmFailureMessage(dmError, 'ما قدرت أرسل الزاجل للعضو.'));
    return;
  }

  const attachmentMessages = await sendAttachmentFollowUps(target, record.attachments, 'مرفقات زاجل');
  record.dmMessageId = dmMessage.id;
  record.dmChannelId = dmMessage.channel.id;
  record.dmAttachmentMessageIds = attachmentMessages.map((message) => message.id);
  const count = await store.update((draft) => {
    const stats = draft.zajil.stats.sentByUser;
    stats[interaction.user.id] = (Number(stats[interaction.user.id]) || 0) + 1;
    record.sentCount = stats[interaction.user.id];
    draft.zajil.messages.unshift(record);
    draft.zajil.messages = draft.zajil.messages.slice(0, 1000);
    return record.sentCount;
  });

  void sendLog(session.guildId, {
    kind: 'clean',
    title: 'رسالة زاجل نظيفة',
    byId: interaction.user.id,
    toId: target.id,
    content,
    count,
    mode: session.mode,
    attachments: record.attachments
  }).catch((error) => console.error('[log] clean failed:', error));

  await replyHidden(interaction, `تم إرسال زاجلك إلى ${target}.`);
}

async function handleLikeButton(interaction, recordId) {
  const config = store.get();
  if (!config.zajil.actionButtons.likeEnabled) {
    await replyHidden(interaction, 'زر اللايك معطل حاليًا.');
    return;
  }

  const record = findRecord(recordId);
  if (!record) {
    await replyHidden(interaction, 'هذه الرسالة غير موجودة أو قديمة.');
    return;
  }

  if (interaction.user.id !== record.targetId) {
    await replyHidden(interaction, 'زر اللايك مخصص لمستلم زاجل فقط.');
    return;
  }

  if (record.likedBy?.includes(interaction.user.id)) {
    await replyHidden(interaction, 'أرسلت لايك على هذا الزاجل من قبل.');
    return;
  }

  if (likeLocks.has(recordId)) {
    await replyHidden(interaction, 'جاري تسجيل اللايك، انتظر لحظة.');
    return;
  }

  likeLocks.add(recordId);
  await deferHidden(interaction);

  try {
    const latest = findRecord(recordId);
    if (latest?.likedBy?.includes(interaction.user.id)) {
      await replyHidden(interaction, 'أرسلت لايك على هذا الزاجل من قبل.');
      return;
    }

    const sender = await client.users.fetch(record.senderId).catch(() => null);
    if (!sender) {
      await replyHidden(interaction, 'ما قدرت أوصل لصاحب الزاجل.');
      return;
    }

    const notification = config.zajil.embed.likeNotification || 'وصلك لايك على رسالة ارسلتها';
    const delivered = await sender.send({
      content: notification
    }).then(() => true).catch(() => false);

    if (!delivered) {
      await replyHidden(interaction, 'ما قدرت أوصل اللايك لصاحب الزاجل، يمكن الخاص عنده مقفل.');
      return;
    }

    await store.update((draft) => {
      const target = draft.zajil.messages.find((item) => item.id === recordId);
      if (!target) return;
      target.likedBy ??= [];
      if (!target.likedBy.includes(interaction.user.id)) target.likedBy.push(interaction.user.id);
    });

    await sendLog(record.guildId, {
      kind: 'like',
      title: 'إعجاب على زاجل',
      byId: interaction.user.id,
      toId: record.senderId,
      content: 'تم تسجيل إعجاب 💗',
      attachments: record.attachments || [],
      count: record.sentCount ?? getSentCount(record.senderId),
      mode: record.mode,
      extra: [{ name: 'الزاجل الأصلي', value: truncate(record.content || 'زاجل مرفق', 1000) }]
    });

    await refreshZajilButtons(findRecord(recordId));
    await replyHidden(interaction, 'تم إرسال اللايك لصاحب الزاجل.');
  } finally {
    likeLocks.delete(recordId);
  }
}

async function handleReplyButton(interaction, recordId) {
  const config = store.get();
  if (!config.zajil.actionButtons.replyEnabled) {
    await replyHidden(interaction, 'زر الرد معطل حاليًا.');
    return;
  }

  const record = findRecord(recordId);
  if (!record) {
    await replyHidden(interaction, 'هذه الرسالة غير موجودة أو قديمة.');
    return;
  }

  if (interaction.user.id !== record.targetId) {
    await replyHidden(interaction, 'زر الرد مخصص لمستلم زاجل فقط.');
    return;
  }

  if (record.replyUsed || record.replies?.length) {
    await replyHidden(interaction, 'تم استخدام الرد على هذا الزاجل من قبل.');
    return;
  }

  if (config.zajil.replyInputMode === 'modal') {
    await interaction.showModal(replyZajilModal(recordId));
    return;
  }

  setPendingReply(interaction.user.id, recordId);
  await replyHidden(
    interaction,
    config.zajil.embed.replyPromptMessage || 'اكتب ردك الآن في نفس هذا الخاص. تقدر ترسل نص أو صور أو فيديو أو GIF أو ملفات، والرد مسموح مرة واحدة فقط.'
  );
}

async function handleReplyModal(interaction, recordId) {
  const content = interaction.fields.getTextInputValue('content').trim();
  const uploadedFiles = interaction.fields.getUploadedFiles('attachments') || new Map();
  const attachments = serializeAttachments(uploadedFiles);
  if (!content && attachments.length === 0) {
    await replyHidden(interaction, 'اكتب رد أو أرفق صورة أو فيديو أو ملف.');
    return;
  }

  const result = await deliverReply(recordId, interaction.user, content, attachments);
  await replyHidden(interaction, result.message);
}

async function handleDirectMessage(message) {
  const pending = pendingReplies.get(message.author.id);
  if (!pending) return;

  if (pending.expiresAt <= Date.now()) {
    pendingReplies.delete(message.author.id);
    await message.reply('انتهى وقت الرد. اضغط زر الرد من الزاجل مرة ثانية.');
    return;
  }

  const content = message.content.trim();
  const attachments = [
    ...serializeAttachments(message.attachments),
    ...serializeStickers(message.stickers)
  ];

  if (!content && attachments.length === 0) {
    await message.reply('اكتب رد أو أرسل صورة أو فيديو أو ملف.');
    return;
  }

  const result = await deliverReply(pending.recordId, message.author, content, attachments);
  if (result.success || result.final) pendingReplies.delete(message.author.id);
  await message.reply(result.message);
}

async function deliverReply(recordId, replier, content, attachments) {
  const record = findRecord(recordId);
  if (!record || replier.id !== record.targetId) {
    return { success: false, final: true, message: 'هذه الرسالة غير موجودة أو قديمة.' };
  }

  if (record.replyUsed || record.replies?.length) {
    return { success: false, final: true, message: 'تم استخدام الرد على هذا الزاجل من قبل.' };
  }

  if (replyLocks.has(recordId)) {
    return { success: false, final: false, message: 'جاري إرسال ردك، انتظر لحظة.' };
  }

  const blockedLink = findBlockedLink(content);
  if (blockedLink) {
    await sendLog(record.guildId, {
      kind: 'blocked',
      title: 'محاولة رد برابط ممنوع',
      byId: replier.id,
      toId: record.senderId,
      content: neutralizeLinks(content),
      attachments,
      count: getSentCount(replier.id),
      mode: 'reply',
      extra: [
        { name: 'الرابط الممنوع', value: neutralizeLinks(blockedLink) },
        { name: 'الزاجل الأصلي', value: truncate(record.content || 'زاجل مرفق', 1000) }
      ]
    });
    return { success: false, final: false, message: 'الروابط ممنوعة في الرد. اكتب ردك بدون روابط.' };
  }

  const blockedWord = findForbiddenWord(content, store.get().zajil.forbiddenWords);
  if (blockedWord) {
    await sendLog(record.guildId, {
      kind: 'blocked',
      title: 'محاولة رد بكلمة ممنوعة',
      byId: replier.id,
      toId: record.senderId,
      content,
      attachments,
      count: getSentCount(replier.id),
      mode: 'reply',
      extra: [{ name: 'الكلمة الممنوعة', value: blockedWord }]
    });
    return { success: false, final: false, message: `ردك يحتوي كلام ممنوع: \`${blockedWord}\`. اكتب رد جديد.` };
  }

  replyLocks.add(recordId);
  try {
    const latest = findRecord(recordId);
    if (!latest || latest.replyUsed || latest.replies?.length) {
      return { success: false, final: true, message: 'تم استخدام الرد على هذا الزاجل من قبل.' };
    }

    const sender = await client.users.fetch(record.senderId).catch(() => null);
    if (!sender) {
      return { success: false, final: true, message: 'ما قدرت أوصل لصاحب الزاجل.' };
    }

    const { message: sent, error: dmError } = await sendDmMessage(sender, buildReplyDmPayload(record, replier, sender, content, attachments), 'zajil-reply');
    if (!sent) {
      return { success: false, final: false, message: dmFailureMessage(dmError, 'ما قدرت أرسل الرد لصاحب الزاجل.') };
    }

    const attachmentMessages = await sendAttachmentFollowUps(sender, attachments, 'مرفقات الرد');
    const savedAttachments = attachments;
    await store.update((draft) => {
      const target = draft.zajil.messages.find((item) => item.id === recordId);
      if (!target) return;
      target.replies ??= [];
      target.replyUsed = true;
      target.replies.push({
        byId: replier.id,
        content,
        attachments: savedAttachments,
        attachmentMessageIds: attachmentMessages.map((message) => message.id),
        createdAt: Date.now()
      });
    });

    void sendLog(record.guildId, {
      kind: 'reply',
      title: 'رد على زاجل',
      byId: replier.id,
      toId: record.senderId,
      content,
      attachments: savedAttachments,
      count: getSentCount(replier.id),
      mode: 'reply',
      extra: [{ name: 'الزاجل الأصلي', value: truncate(record.content || 'زاجل مرفق', 1000) }]
    }).catch((error) => console.error('[log] reply failed:', error));

    await refreshZajilButtons(findRecord(recordId));
    return { success: true, final: true, message: 'تم إرسال ردك لصاحب الزاجل.' };
  } finally {
    replyLocks.delete(recordId);
  }
}

function buildZajilDmPayload(record, sender, target) {
  const config = store.get().zajil;
  const attachmentPayload = messageAttachmentPayload(record.attachments);
  const embed = new EmbedBuilder()
    .setColor(hexToNumber(config.embed.color) ?? 0x7d4ac7)
    .setDescription(formatLargeDmMessage(record.content || 'مرفق فقط'))
    .setThumbnail(target.displayAvatarURL({ extension: 'png', size: 256 }))
    .setFooter({ text: 'zajil' })
    .setTimestamp(new Date(record.createdAt));

  if (record.mode === 'visible') {
    embed.addFields({ name: 'المرسل', value: `${sender}`, inline: true });
  }

  if (attachmentPayload.imageUrl) {
    embed.setImage(attachmentPayload.imageUrl);
  }

  return {
    content: formatHeader(config.embed.messageText, config.embed.messageEmoji, target.id),
    embeds: [embed],
    files: attachmentPayload.files,
    components: buildZajilButtonComponents(record, config)
  };
}

function buildReplyDmPayload(record, replier, sender, content, attachments = []) {
  const config = store.get().zajil;
  const attachmentPayload = messageAttachmentPayload(attachments);
  const embed = new EmbedBuilder()
    .setColor(hexToNumber(config.embed.color) ?? 0x7d4ac7)
    .setDescription(formatReplyDmDescription(content || 'مرفق فقط', replier, record.content || 'زاجل مرفق'))
    .setThumbnail(replier.displayAvatarURL({ extension: 'png', size: 256 }))
    .setFooter({ text: 'zajil' })
    .setTimestamp();

  if (attachmentPayload.imageUrl) {
    embed.setImage(attachmentPayload.imageUrl);
  }

  return {
    content: formatHeader(config.embed.replyText, config.embed.replyEmoji, sender.id),
    embeds: [embed],
    files: attachmentPayload.files
  };
}

function buildZajilButtonComponents(record, config = store.get().zajil) {
  const buttons = [];

  if (config.actionButtons.likeEnabled) {
    const button = buttonFromShape(`zajil:like:${record.id}`, config.actionButtons.likeShape, ButtonStyle.Secondary, 'لايك');
    button.setDisabled(Boolean(record.likedBy?.includes(record.targetId)));
    buttons.push(button);
  }

  if (config.actionButtons.replyEnabled) {
    const button = buttonFromShape(`zajil:reply:${record.id}`, config.actionButtons.replyShape, ButtonStyle.Secondary, 'رد');
    button.setDisabled(Boolean(record.replyUsed || record.replies?.length));
    buttons.push(button);
  }

  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

async function refreshZajilButtons(record) {
  if (!record?.dmMessageId) return;

  const target = await client.users.fetch(record.targetId).catch(() => null);
  const dm = target ? await target.createDM().catch(() => null) : null;
  const message = dm ? await dm.messages.fetch(record.dmMessageId).catch(() => null) : null;
  if (!message) return;

  await message.edit({ components: buildZajilButtonComponents(record) }).catch(() => null);
}

function formatHeader(text, emoji, mentionId) {
  return `${text || ''} ${emoji || ''} <@${mentionId}>`.replace(/\s+/g, ' ').trim();
}

function formatLargeDmMessage(value, maxLength = 3600) {
  const text = truncate(value || 'مرفق فقط', maxLength);
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `# ${line.trim()}` : ''))
    .join('\n')
    .trim() || '# مرفق فقط';
}

function formatReplyDmDescription(content, replier, originalContent) {
  const replyText = formatLargeDmMessage(content || 'مرفق فقط', 1400);
  const originalText = formatLargeDmMessage(originalContent || 'زاجل مرفق', 1400);

  return truncate(`${replyText}\n\n**from:** ${replier}\n\nعلى زاجلك:\n${originalText}`, 4000);
}

async function setPrefix(interaction) {
  const prefix = interaction.fields.getTextInputValue('value').trim();

  if (!prefix || /\s/.test(prefix) || prefix.length > 10) {
    await replyHidden(interaction, 'البرفكس لازم يكون بدون مسافات وبحد أقصى 10 أحرف.');
    return;
  }

  await store.update((config) => {
    config.prefix = prefix;
  });

  await replyHidden(interaction, `تم تغيير البرفكس. الأمر الآن: \`${prefix}settings\` أو \`${prefix}اعدادات\`.`);
}

async function promptToggleAuthorized(interaction) {
  await replyHidden(interaction, 'منشن الشخص أو ارسل ايديه. إذا كان موجود في المصرحين راح ينشال، وإذا مو موجود ينضاف.');

  const message = await waitForUserMessage(interaction);
  if (!message) {
    await followHidden(interaction, 'انتهى الوقت، جرب مرة ثانية.');
    return;
  }

  const userId = extractId(message.content);
  await deleteQuietly(message);

  if (!userId) {
    await followHidden(interaction, 'ما قدرت ألقى ايدي الشخص.');
    return;
  }

  let added = false;
  await store.update((config) => {
    if (config.authorizedUserIds.includes(userId)) {
      config.authorizedUserIds = config.authorizedUserIds.filter((id) => id !== userId);
      added = false;
      return;
    }

    config.authorizedUserIds.push(userId);
    config.authorizedUserIds = unique(config.authorizedUserIds);
    added = true;
  });

  await followHidden(interaction, added ? `تمت إضافة <@${userId}> للمصرحين.` : `تمت إزالة <@${userId}> من المصرحين.`);
}

async function showAuthorizedUsers(interaction) {
  const { authorizedUserIds } = store.get();
  const list = authorizedUserIds.length ? authorizedUserIds.map((id, index) => `${index + 1}. <@${id}>`).join('\n') : 'ما فيه مصرحين حاليًا.';
  await replyHidden(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle('المصرحين')
        .setDescription(list)
        .setColor(0x7d4ac7)
    ]
  });
}

async function setBotName(interaction) {
  const name = interaction.fields.getTextInputValue('value').trim();

  if (!name) {
    await replyHidden(interaction, 'اكتب اسم صحيح.');
    return;
  }

  await client.user.setUsername(name);
  await replyHidden(interaction, `تم تغيير اسم البوت إلى: ${name}`);
}

async function promptBotImage(interaction, type) {
  await replyHidden(interaction, type === 'avatar' ? 'ارسل صورة الافتار الجديدة الآن.' : 'ارسل صورة البنر الجديدة الآن.');

  const message = await waitForUserMessage(interaction);
  if (!message) {
    await followHidden(interaction, 'انتهى الوقت، جرب مرة ثانية.');
    return;
  }

  try {
    const image = await imageFromMessage(message);
    await deleteQuietly(message);

    if (type === 'avatar') {
      await client.user.setAvatar(image.buffer);
      await followHidden(interaction, 'تم تغيير افتار البوت.');
      return;
    }

    await setBotBanner(image);
    await followHidden(interaction, 'تم تغيير بنر البوت.');
  } catch (error) {
    console.error('[bot image] failed:', error);
    await followHidden(interaction, 'ما قدرت أغير الصورة. تأكد أنها صورة صالحة وأن البوت يملك صلاحية التعديل.');
  }
}

async function setBotBanner(image) {
  if (typeof client.user.setBanner === 'function') {
    await client.user.setBanner(image.buffer);
    return;
  }

  await client.rest.patch(Routes.user(), {
    body: {
      banner: `data:${image.contentType};base64,${image.buffer.toString('base64')}`
    }
  });
}

async function setBotStatus(interaction, type) {
  const text = interaction.fields.getTextInputValue('value').trim();

  if (!ACTIVITY_TYPES[type] || !text) {
    await replyHidden(interaction, 'نوع الحالة أو النص غير صحيح.');
    return;
  }

  client.user.setPresence({
    activities: [{ name: text, type: ACTIVITY_TYPES[type] }],
    status: 'online'
  });

  await store.update((config) => {
    config.botStatus = { type, text };
  });

  await replyHidden(interaction, `تم حفظ الحالة: ${ACTIVITY_LABELS[type]} ${text}`);
}

async function promptDisplayImage(interaction) {
  await replyHidden(interaction, 'ارسل صورة العرض الآن. بتنحفظ وتظهر فوق زر الإرسال في القائمة.');

  const message = await waitForUserMessage(interaction);
  if (!message) {
    await followHidden(interaction, 'انتهى الوقت، جرب مرة ثانية.');
    return;
  }

  try {
    const image = await imageFromMessage(message);
    await fs.mkdir(ASSETS_DIR, { recursive: true });
    const extension = IMAGE_EXTENSIONS.get(image.contentType) || '.png';
    const imagePath = path.join(ASSETS_DIR, `zajil-display${extension}`);
    await fs.writeFile(imagePath, image.buffer);
    await deleteQuietly(message);

    await store.update((config) => {
      config.zajil.displayImagePath = imagePath;
    });

    await followHidden(interaction, 'تم حفظ صورة العرض.');
  } catch (error) {
    console.error('[display image] failed:', error);
    await followHidden(interaction, 'ما قدرت أحفظ الصورة. ارسل صورة مباشرة أو رابط صورة صالح.');
  }
}

async function sendZajilMenuFromModal(interaction) {
  const input = interaction.fields.getTextInputValue('value').trim();
  const channelId = extractId(input);

  if (!channelId || !interaction.guild) {
    await replyHidden(interaction, 'اكتب منشن الشات أو ايديه.');
    return;
  }

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await replyHidden(interaction, 'الشات غير صحيح أو البوت ما يقدر يوصله.');
    return;
  }

  await sendZajilMenu(channel);
  await store.update((config) => {
    config.zajil.menuChannelId = channel.id;
  });

  await replyHidden(interaction, `تم إرسال قائمة زاجل في ${channel}.`);
}

async function sendZajilMenu(channel) {
  const config = store.get().zajil;

  if (config.menuChannelId && config.menuMessageId) {
    const oldChannel = await channel.guild.channels.fetch(config.menuChannelId).catch(() => null);
    const oldMessage = oldChannel?.isTextBased()
      ? await oldChannel.messages.fetch(config.menuMessageId).catch(() => null)
      : null;
    await oldMessage?.delete().catch(() => null);
  }

  const files = [];
  if (config.displayImagePath) {
    files.push(new AttachmentBuilder(config.displayImagePath));
  }

  const sent = await channel.send({
    content: files.length ? '' : 'اضغط الزر لإرسال زاجل.',
    files,
    components: buildZajilMenuComponents(config)
  });

  await store.update((draft) => {
    draft.zajil.menuChannelId = channel.id;
    draft.zajil.menuMessageId = sent.id;
  });
}

function buildZajilMenuComponents(config = store.get().zajil) {
  return [
    new ActionRowBuilder().addComponents(
      buttonFromShape('zajil:open', config.sendButton.shape, sendButtonStyleValue(config.sendButton.style), 'إرسال زاجل')
    )
  ];
}

async function updateStoredZajilMenuButton(guild) {
  const config = store.get().zajil;
  if (!guild || !config.menuChannelId || !config.menuMessageId) return false;

  const channel = await guild.channels.fetch(config.menuChannelId).catch(() => null);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(config.menuMessageId).catch(() => null)
    : null;

  if (!message) return false;
  await message.edit({ components: buildZajilMenuComponents(config) });
  return true;
}

async function setEmbedColor(interaction) {
  const color = normalizeHexColor(interaction.fields.getTextInputValue('value'));

  if (!color) {
    await replyHidden(interaction, 'اكتب لون صحيح مثل: #FFFFFF');
    return;
  }

  await store.update((config) => {
    config.zajil.embed.color = color;
  });
  await replyHidden(interaction, `تم حفظ لون الامبيد: \`${color}\`.`);
}

async function setMessageFormat(interaction) {
  const text = interaction.fields.getTextInputValue('text').trim();
  const emoji = interaction.fields.getTextInputValue('emoji').trim();

  await store.update((config) => {
    config.zajil.embed.messageText = text || 'وصلتك زاجل';
    config.zajil.embed.messageEmoji = emoji;
  });

  await replyHidden(interaction, 'تم حفظ رسالة وإيموجي زاجل.');
}

async function setReplyFormat(interaction) {
  const text = interaction.fields.getTextInputValue('text').trim();
  const emoji = interaction.fields.getTextInputValue('emoji').trim();

  await store.update((config) => {
    config.zajil.embed.replyText = text || 'وصلك رد على زاجلك';
    config.zajil.embed.replyEmoji = emoji;
  });

  await replyHidden(interaction, 'تم حفظ رسالة وإيموجي الرد.');
}

async function updateSimpleZajilSetting(interaction, keyPath, successMessage) {
  const value = interaction.fields.getTextInputValue('value').trim();

  if (!value) {
    await replyHidden(interaction, 'اكتب قيمة صحيحة.');
    return;
  }

  await store.update((config) => {
    setByPath(config.zajil, keyPath, value);
  });

  if (keyPath === 'sendButton.shape') {
    await updateStoredZajilMenuButton(interaction.guild).catch((error) => console.error('[menu button shape] failed:', error));
  }

  await replyHidden(interaction, successMessage);
}

async function promptTextSetting(interaction, keyPath, prompt, successMessage) {
  await replyHidden(interaction, prompt);
  const message = await waitForUserMessage(interaction);

  if (!message) {
    await followHidden(interaction, 'انتهى الوقت، جرب مرة ثانية.');
    return;
  }

  const value = message.content.trim();
  await deleteQuietly(message);

  if (!value) {
    await followHidden(interaction, 'الرسالة ما فيها نص أو إيموجي.');
    return;
  }

  await store.update((config) => {
    setByPath(config.zajil, keyPath, value.slice(0, 1900));
  });
  await followHidden(interaction, successMessage);
}

async function setForbiddenWords(interaction) {
  const raw = interaction.fields.getTextInputValue('value').trim();
  let words = [...store.get().zajil.forbiddenWords];

  if (!raw) {
    await replyHidden(interaction, 'اكتب كلمة واحدة على الأقل.');
    return;
  }

  if (['clear', 'مسح', 'حذف الكل'].includes(raw.toLowerCase())) {
    words = [];
  } else {
    for (const item of raw.split(/[\n,]+/).map((word) => word.trim()).filter(Boolean)) {
      const removeMatch = item.match(/^(حذف|remove|delete)\s*[:：]?\s*(.+)$/i);
      if (removeMatch) {
        words = words.filter((word) => word.toLowerCase() !== removeMatch[2].trim().toLowerCase());
        continue;
      }

      words.push(item);
    }
  }

  words = unique(words).slice(0, 200);

  await store.update((config) => {
    config.zajil.forbiddenWords = words;
  });

  await replyHidden(interaction, words.length ? `تم حفظ الكلمات الممنوعة. العدد الآن: ${words.length}` : 'تم مسح كل الكلمات الممنوعة.');
}

async function handleModerationCommand(message, prefix, content) {
  if (!content.startsWith(prefix)) return false;

  const body = content.slice(prefix.length).trim();
  const blockMatch = body.match(/^(?:block|حظر)\s+(.+)$/i);
  const unblockMatch = body.match(/^(?:unblok|unblock|الغاء\s+حظر|إلغاء\s+حظر)\s+(.+)$/i);
  if (!blockMatch && !unblockMatch) return false;

  if (!(await canUseSettings(message.author.id))) {
    await message.reply('ما عندك صلاحية استخدام أوامر الحظر.');
    return true;
  }

  const targetId = extractId((blockMatch || unblockMatch)[1]);
  if (!targetId) {
    await message.reply(`استخدم منشن أو ايدي صحيح. مثال: \`${prefix}حظر @user\``);
    return true;
  }

  if (unblockMatch) {
    const removed = await unblockUser(message.guild.id, targetId);
    await message.reply(removed ? `تم إلغاء حظر <@${targetId}> من إرسال زاجل.` : `<@${targetId}> غير محظور حاليًا.`);
    return true;
  }

  const validation = await validateBlockTarget(targetId, message.author.id);
  if (!validation.ok) {
    await message.reply(validation.message);
    return true;
  }

  const sessionId = createSession({
    kind: 'block',
    guildId: message.guild.id,
    requesterId: message.author.id,
    targetId
  });
  await message.reply(blockDurationPayload(sessionId, targetId));
  return true;
}

async function promptBlockUser(interaction) {
  await replyHidden(interaction, 'منشن الشخص الذي تريد حظره أو ارسل ايديه.');
  const message = await waitForUserMessage(interaction);

  if (!message) {
    await followHidden(interaction, 'انتهى الوقت، جرب مرة ثانية.');
    return;
  }

  const targetId = extractId(message.content);
  await deleteQuietly(message);
  if (!targetId) {
    await followHidden(interaction, 'ما قدرت ألقى ايدي الشخص.');
    return;
  }

  const validation = await validateBlockTarget(targetId, interaction.user.id);
  if (!validation.ok) {
    await followHidden(interaction, validation.message);
    return;
  }

  const sessionId = createSession({
    kind: 'block',
    guildId: interaction.guild.id,
    requesterId: interaction.user.id,
    targetId
  });
  await followHidden(interaction, blockDurationPayload(sessionId, targetId));
}

async function promptUnblockUser(interaction) {
  await replyHidden(interaction, 'منشن الشخص الذي تريد فك حظره أو ارسل ايديه.');
  const message = await waitForUserMessage(interaction);

  if (!message) {
    await followHidden(interaction, 'انتهى الوقت، جرب مرة ثانية.');
    return;
  }

  const targetId = extractId(message.content);
  await deleteQuietly(message);
  if (!targetId) {
    await followHidden(interaction, 'ما قدرت ألقى ايدي الشخص.');
    return;
  }

  const removed = await unblockUser(interaction.guild.id, targetId);
  await followHidden(interaction, removed ? `تم إلغاء حظر <@${targetId}> من إرسال زاجل.` : `<@${targetId}> غير محظور حاليًا.`);
}

async function showBlockedUsers(interaction) {
  await pruneExpiredBlocks();
  const list = activeBlocks(interaction.guild?.id);
  const description = list.length
    ? list.map((block, index) => `${index + 1}. <@${block.userId}> - ${block.blockedUntil ? `<t:${Math.floor(block.blockedUntil / 1000)}:R>` : 'دائم'}`).join('\n')
    : 'ما فيه أشخاص محظورين حاليًا.';

  await replyHidden(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle('المحظورون من إرسال زاجل')
        .setDescription(description)
        .setColor(0xe74c3c)
    ]
  });
}

async function handleBlockDurationSelect(interaction) {
  const sessionId = interaction.customId.split(':').at(-1);
  const session = sessions.get(sessionId);

  if (!session || session.kind !== 'block' || session.requesterId !== interaction.user.id) {
    await replyHidden(interaction, 'انتهت عملية الحظر. اكتب الأمر من جديد.');
    return;
  }

  const days = Number(interaction.values[0]);
  if (![0, 1, 2, 5, 15, 30].includes(days)) {
    await replyHidden(interaction, 'مدة الحظر غير صحيحة.');
    return;
  }

  sessions.delete(sessionId);
  const blockedUntil = days === 0 ? null : Date.now() + (days * 24 * 60 * 60 * 1000);
  await store.update((config) => {
    config.zajil.blockedUsers = config.zajil.blockedUsers.filter((block) => !(block.guildId === session.guildId && block.userId === session.targetId));
    config.zajil.blockedUsers.push({
      guildId: session.guildId,
      userId: session.targetId,
      blockedBy: interaction.user.id,
      blockedAt: Date.now(),
      blockedUntil
    });
  });

  const duration = blockedUntil ? `<t:${Math.floor(blockedUntil / 1000)}:R>` : 'بشكل دائم';
  await interaction.update({ content: `تم حظر <@${session.targetId}> من إرسال زاجل ${duration}.`, embeds: [], components: [] });
}

function blockDurationPayload(sessionId, targetId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`block:duration:${sessionId}`)
    .setPlaceholder('اختر مدة الحظر')
    .addOptions(
      option('يوم', 'حظر لمدة 24 ساعة', '1'),
      option('يومين', 'حظر لمدة 48 ساعة', '2'),
      option('5 أيام', 'حظر لمدة خمسة أيام', '5'),
      option('15 يوم', 'حظر لمدة خمسة عشر يومًا', '15'),
      option('30 يوم', 'حظر لمدة شهر', '30'),
      option('دائم', 'الحظر مستمر حتى يتم فكه يدويًا', '0')
    );

  return {
    content: `حدد مدة حظر <@${targetId}> من إرسال زاجل.`,
    components: [new ActionRowBuilder().addComponents(menu)]
  };
}

async function validateBlockTarget(targetId, requesterId) {
  if (targetId === requesterId) return { ok: false, message: 'ما تقدر تحظر نفسك.' };
  if (store.get().ownerIds.includes(targetId) || envOwnerIds.has(targetId)) {
    return { ok: false, message: 'ما تقدر تحظر مالك البوت.' };
  }

  const user = await client.users.fetch(targetId).catch(() => null);
  if (!user) return { ok: false, message: 'ما قدرت ألقى هذا الشخص.' };
  if (user.bot) return { ok: false, message: 'ما تقدر تحظر بوت من إرسال زاجل.' };
  return { ok: true };
}

async function unblockUser(guildId, userId) {
  let removed = false;
  await store.update((config) => {
    const before = config.zajil.blockedUsers.length;
    config.zajil.blockedUsers = config.zajil.blockedUsers.filter((block) => !(block.guildId === guildId && block.userId === userId));
    removed = config.zajil.blockedUsers.length < before;
  });
  return removed;
}

function findActiveBlock(userId, guildId) {
  const now = Date.now();
  return store.get().zajil.blockedUsers.find((block) => {
    return block.userId === userId && block.guildId === guildId && (!block.blockedUntil || block.blockedUntil > now);
  }) || null;
}

function activeBlocks(guildId = null) {
  const now = Date.now();
  return store.get().zajil.blockedUsers.filter((block) => {
    return (!guildId || block.guildId === guildId) && (!block.blockedUntil || block.blockedUntil > now);
  });
}

async function pruneExpiredBlocks() {
  await store.update((config) => {
    const now = Date.now();
    config.zajil.blockedUsers = config.zajil.blockedUsers.filter((block) => !block.blockedUntil || block.blockedUntil > now);
  });
}

function blockNotice(block) {
  return block.blockedUntil
    ? `أنت محظور من إرسال زاجل حتى <t:${Math.floor(block.blockedUntil / 1000)}:F> (<t:${Math.floor(block.blockedUntil / 1000)}:R>).`
    : 'أنت محظور من إرسال زاجل بشكل دائم.';
}

async function createLogChannel(interaction) {
  if (!interaction.guild) {
    await replyHidden(interaction, 'اللوق ينشأ داخل السيرفر فقط.');
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL });

  const guild = interaction.guild;
  const savedLog = store.get().zajil.log;
  const existingLog = savedLog.channelId ? await guild.channels.fetch(savedLog.channelId).catch(() => null) : null;

  if (existingLog?.isTextBased()) {
    await interaction.editReply(`اللوق موجود مسبقًا: ${existingLog}`);
    return;
  }

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory
      ]
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  const category = await guild.channels.create({
    name: 'zajil-log',
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites
  });

  const channel = await guild.channels.create({
    name: 'zajil-log',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites
  });

  await store.update((config) => {
    config.zajil.log = {
      guildId: guild.id,
      categoryId: category.id,
      channelId: channel.id
    };
  });

  await interaction.editReply(`تم إنشاء لوق زاجل: ${channel}`);
}

async function sendLog(guildId, data) {
  const config = store.get().zajil;
  if (!config.log.channelId) return;

  const guild = await client.guilds.fetch(guildId || config.log.guildId).catch(() => null);
  const channel = guild ? await guild.channels.fetch(config.log.channelId).catch(() => null) : null;
  if (!channel || !channel.isTextBased()) return;

  const kind = LOG_COLORS[data.kind] ? data.kind : 'clean';
  const users = {
    by: await logUserLabel(guild, data.byId),
    to: await logUserLabel(guild, data.toId)
  };
  const files = [];
  const embed = new EmbedBuilder()
    .setTitle(`${LOG_MARKS[kind]} ${data.title}`)
    .setColor(LOG_COLORS[kind])
    .setDescription(buildLogDescription(data, users))
    .setTimestamp();

  const iconFile = LOG_ICON_FILES[kind];
  const iconPath = iconFile ? path.join(LOG_ICONS_DIR, iconFile) : null;
  if (iconPath && files.length < 10 && fsSync.existsSync(iconPath)) {
    const iconName = `zajil-${kind}-icon.png`;
    files.unshift(new AttachmentBuilder(iconPath, { name: iconName }));
    embed.setThumbnail(`attachment://${iconName}`);
  }

  const firstImage = (data.attachments || []).find(isImageAttachment);
  if (firstImage?.url) {
    embed.setImage(firstImage.url);
  }

  await channel.send({ embeds: [embed], files }).catch((error) => console.error('[log] failed:', error));

  for (const payload of attachmentFollowUpPayloads(data.attachments || [], 'مرفقات اللوق')) {
    await channel.send(payload).catch((error) => console.error('[log] attachment link failed:', error));
  }
}

function buildLogDescription(data, users = {}) {
  const sections = [
    `### BY\n${users.by || userProfileLabel(data.byId)}`,
    `### TO\n${users.to || userProfileLabel(data.toId)}`,
    `### SEND\n${truncate(data.content, 1000)}`,
    `### نوع الإرسال\n**${logModeLabel(data.mode)}**`,
    `### عدد زواجل المرسل\n**${data.count ?? 0}**`
  ];

  for (const field of data.extra || []) {
    sections.push(`### ${field.name}\n${truncate(field.value, 1000)}`);
  }

  if (data.attachments?.length) {
    sections.push(`### المرفقات\n${truncate(attachmentSummary(data.attachments), 1000)}`);
  }

  return truncate(sections.join('\n\n'), 4000);
}

function singleInputModal(customId, title, inputId, label, value = '', maxLength = 200) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(inputId)
          .setLabel(label.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(value || '').slice(0, maxLength))
          .setMaxLength(maxLength)
      )
    );
}

function messageFormatModal(customId, title, textValue, emojiValue) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('text')
          .setLabel('نص الرسالة')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(textValue || '').slice(0, 200))
          .setMaxLength(200)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('emoji')
          .setLabel('الإيموجي')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(emojiValue || '').slice(0, 80))
          .setMaxLength(80)
      )
    );
}

function forbiddenWordsModal() {
  return new ModalBuilder()
    .setCustomId('modal:forbidden_words')
    .setTitle('الكلمات الممنوعة')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('كلمات بسطر أو فاصلة')
          .setPlaceholder('كلمة1\nكلمة2\nحذف: كلمة3\nclear')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1800)
      )
    );
}

function composeZajilModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(`modal:compose:${sessionId}`)
    .setTitle('اكتب زاجلك')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel('محتوى الرسالة (اختياري مع المرفق)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1800)
      )
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('المرفقات (اختياري)')
        .setDescription('صور، فيديو، GIF أو أي ملف - حتى 10 ملفات')
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId('attachments')
            .setMinValues(0)
            .setMaxValues(10)
            .setRequired(false)
        )
    );
}

function composeZajilSearchModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(`modal:compose-search:${sessionId}`)
    .setTitle('إرسال زاجل بالبحث')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('recipient')
          .setLabel('يوزر أو آيدي المستلم')
          .setPlaceholder('مثال: ahmed أو 123456789012345678')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel('محتوى الرسالة (اختياري مع المرفق)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1800)
      )
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('المرفقات (اختياري)')
        .setDescription('صور، فيديو، GIF أو أي ملف - حتى 10 ملفات')
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId('attachments')
            .setMinValues(0)
            .setMaxValues(10)
            .setRequired(false)
        )
    );
}

function replyZajilModal(recordId) {
  return new ModalBuilder()
    .setCustomId(`modal:reply:${recordId}`)
    .setTitle('الرد على زاجل')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel('محتوى الرد (اختياري مع المرفق)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1800)
      )
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('المرفقات (اختياري)')
        .setDescription('صور، فيديو، GIF أو أي ملف - حتى 10 ملفات')
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId('attachments')
            .setMinValues(0)
            .setMaxValues(10)
            .setRequired(false)
        )
    );
}

function buttonFromShape(customId, rawShape, style, fallbackLabel) {
  const shape = parseButtonShape(rawShape, fallbackLabel);
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setStyle(style);

  if (shape.emoji) button.setEmoji(shape.emoji);
  if (shape.label) {
    button.setLabel(shape.label.slice(0, 80));
  } else if (!shape.emoji) {
    button.setLabel(fallbackLabel.slice(0, 80));
  }

  return button;
}

function parseButtonShape(value, fallbackLabel) {
  const raw = String(value || '').trim();
  if (!raw) return { label: fallbackLabel, emoji: null };

  const customMatch = raw.match(/<(?<animated>a?):(?<name>[A-Za-z0-9_]+):(?<id>\d+)>/);
  if (customMatch?.groups) {
    const label = raw.replace(customMatch[0], '').trim();
    return {
      label: label || null,
      emoji: {
        id: customMatch.groups.id,
        name: customMatch.groups.name,
        animated: customMatch.groups.animated === 'a'
      }
    };
  }

  const emojiMatch = raw.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)/u);
  if (emojiMatch) {
    const label = raw.slice(emojiMatch[0].length).trim();
    return {
      label: label || null,
      emoji: { name: emojiMatch[0] }
    };
  }

  return { label: raw, emoji: null };
}

async function canUseSettings(userId) {
  const config = store.get();
  const hasOwner = config.ownerIds.length > 0 || envOwnerIds.size > 0;

  if (!hasOwner) {
    await store.update((draft) => {
      draft.ownerIds = unique([...draft.ownerIds, userId]);
    });
    return true;
  }

  return envOwnerIds.has(userId) || config.ownerIds.includes(userId) || config.authorizedUserIds.includes(userId);
}

async function applyStoredPresence() {
  const { botStatus } = store.get();
  if (!botStatus?.type || !botStatus?.text || !ACTIVITY_TYPES[botStatus.type]) return;

  client.user.setPresence({
    activities: [{ name: botStatus.text, type: ACTIVITY_TYPES[botStatus.type] }],
    status: 'online'
  });
}

function createSession(data) {
  const id = shortId();
  sessions.set(id, data);

  setTimeout(() => {
    sessions.delete(id);
  }, SESSION_TIMEOUT_MS).unref();

  return id;
}

function shortId() {
  return crypto.randomBytes(8).toString('hex');
}

function findRecord(recordId) {
  return store.get().zajil.messages.find((item) => item.id === recordId) || null;
}

function getSentCount(userId) {
  return Number(store.get().zajil.stats.sentByUser[userId]) || 0;
}

function findForbiddenWord(content, words) {
  const normalized = normalizeForbiddenText(content);
  return words.find((word) => {
    const normalizedWord = normalizeForbiddenText(word);
    if (!normalizedWord) return false;

    return hasForbiddenTerm(normalized, normalizedWord);
  }) || null;
}

function hasForbiddenTerm(content, word) {
  let startIndex = 0;

  while (startIndex < content.length) {
    const index = content.indexOf(word, startIndex);
    if (index === -1) return false;

    const before = index > 0 ? content[index - 1] : '';
    const after = content[index + word.length] || '';

    if (!isWordCharacter(before) && !isWordCharacter(after)) {
      return true;
    }

    startIndex = index + word.length;
  }

  return false;
}

function normalizeForbiddenText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .toLocaleLowerCase()
    .trim();
}

function isWordCharacter(value) {
  return value ? /[\p{L}\p{N}_]/u.test(value) : false;
}

function findBlockedLink(content) {
  const text = String(content || '');
  const patterns = [
    /https?:\/\/[^\s<>()]+/i,
    /www\.[^\s<>()]+/i,
    /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[^\s<>()]+/i,
    /\b(?:[a-z0-9-]+\.)+(?:com|net|org|gg|io|co|me|tv|xyz|app|dev|sa|ae|kw|qa|bh|om|ly|link|site|store|shop|online)\b(?:\/[^\s<>()]*)?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  return null;
}

function neutralizeLinks(value) {
  return String(value || '')
    .replace(/https?:\/\//gi, (match) => match.replace('http', 'hxxp'))
    .replace(/\./g, '.\u200b');
}

function logModeLabel(mode) {
  if (mode === 'anonymous') return 'مجهول';
  if (mode === 'visible') return 'ظاهر';
  if (mode === 'reply') return 'رد';
  return mode || 'غير معروف';
}

function enabledLabel(value) {
  return value ? 'مفعل' : 'معطل';
}

function statusCircle(value) {
  return value ? '🟢' : '🔴';
}

function toggleDescription(value) {
  return value ? 'مفعل - اضغط للتعطيل' : 'معطل - اضغط للتفعيل';
}

function statusLabel(status) {
  if (!status?.type || !status?.text) return 'بدون حالة';
  return `${ACTIVITY_LABELS[status.type] || status.type} ${status.text}`;
}

function sendButtonStyleKey(value) {
  return SEND_BUTTON_STYLES[value] ? value : 'primary';
}

function sendButtonStyleValue(value) {
  return SEND_BUTTON_STYLES[sendButtonStyleKey(value)].style;
}

function sendButtonStyleLabel(value) {
  return SEND_BUTTON_STYLES[sendButtonStyleKey(value)].label;
}

function replyInputModeLabel(mode) {
  return mode === 'modal' ? 'نافذة' : 'نفس الشات الخاص';
}

function setByPath(target, keyPath, value) {
  const keys = keyPath.split('.');
  let current = target;

  for (const key of keys.slice(0, -1)) {
    current[key] ??= {};
    current = current[key];
  }

  current[keys.at(-1)] = value;
}

function setPendingReply(userId, recordId) {
  const pending = {
    recordId,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS
  };
  pendingReplies.set(userId, pending);

  setTimeout(() => {
    if (pendingReplies.get(userId) === pending) pendingReplies.delete(userId);
  }, SESSION_TIMEOUT_MS).unref();
}

function serializeAttachments(collection) {
  if (!collection) return [];

  return [...collection.values()].slice(0, 10).map((attachment, index) => ({
    url: attachment.url,
    name: attachment.name || `file-${index + 1}`,
    contentType: attachment.contentType || null,
    size: Number(attachment.size) || null
  }));
}

function serializeStickers(collection) {
  if (!collection) return [];

  return [...collection.values()].map((sticker, index) => {
    let extension = '.png';
    try {
      extension = path.extname(new URL(sticker.url).pathname) || extension;
    } catch {}

    return {
      url: sticker.url,
      name: `${safeFileName(sticker.name || `sticker-${index + 1}`)}${extension}`,
      contentType: null,
      size: null
    };
  });
}

async function sendDmMessage(user, payload, context) {
  try {
    return { message: await user.send(payload), error: null };
  } catch (error) {
    console.error(`[dm:${context}] failed:`, {
      userId: user?.id,
      code: error?.code,
      status: error?.status,
      message: error?.message
    });
    return { message: null, error };
  }
}

function dmFailureMessage(error, fallback) {
  if (error?.code === 50007) {
    return `${fallback} الخاص عند العضو مقفل أو مانع رسائل البوت.`;
  }

  if (error?.code === 40005 || error?.status === 413 || /too large|request entity/i.test(error?.message || '')) {
    return `${fallback} ديسكورد رفض حجم المرفق. جرّب ضغط المقطع أو خله أقل من 24MB.`;
  }

  return `${fallback} ديسكورد رفض الإرسال مؤقتًا، جرّب مرة ثانية.`;
}

async function sendAttachmentFollowUps(user, attachments = [], label = 'المرفقات') {
  const sentMessages = [];

  for (const payload of attachmentFollowUpPayloads(attachments, label)) {
    const { message } = await sendDmMessage(user, payload, 'attachment-followup');
    if (message) sentMessages.push(message);
  }

  return sentMessages;
}

function attachmentFollowUpPayloads(attachments = [], label = 'المرفقات') {
  const firstImageIndex = attachments.findIndex(isImageAttachment);
  const links = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment, index }) => attachment.url && index !== firstImageIndex)
    .map(({ attachment }) => `🔗 [${displayAttachmentName(attachment)}](${attachment.url})`);

  return linkPayloads(links, label);
}

function displayAttachmentName(attachment) {
  if (isVideoAttachment(attachment)) return 'دولة الشاهي.mp4';
  return safeFileName(attachment.name || 'مرفق');
}

function isVideoAttachment(attachment) {
  const contentType = String(attachment.contentType || '').toLowerCase();
  const source = `${attachment.name || ''} ${attachment.url || ''}`.toLowerCase();
  return contentType.startsWith('video/') || /\.(mp4|mov|m4v|webm)(?:$|[?#])/i.test(source);
}

function linkPayloads(links, label) {
  if (!links.length) return [];

  const payloads = [];
  let current = `${label}:\n`;

  for (const link of links) {
    const line = String(link);
    const separator = current.endsWith('\n') ? '' : '\n';

    if (current.length + separator.length + line.length > 1900) {
      payloads.push({ content: current.trim() });
      current = `${label}:\n${line}`;
    } else {
      current += `${separator}${line}`;
    }
  }

  if (current.trim() !== `${label}:`) payloads.push({ content: current.trim() });
  return payloads;
}

function messageAttachmentPayload(attachments = []) {
  const image = attachments.find(isImageAttachment);

  return {
    files: [],
    imageUrl: image?.url || null
  };
}

function isImageAttachment(attachment) {
  const contentType = String(attachment.contentType || '').toLowerCase();
  return contentType.startsWith('image/') || looksLikeImageUrl(attachment.url) || looksLikeImageUrl(attachment.name);
}

function attachmentSummary(attachments = []) {
  return attachments.map((attachment, index) => {
    const name = displayAttachmentName(attachment || {}).replace(/[\[\]]/g, '') || `مرفق ${index + 1}`;
    return `[${name}](${attachment.url})`;
  }).join('\n');
}

async function logUserLabel(guild, userId) {
  if (!userId) return 'غير معروف';

  const member = guild
    ? await guild.members.fetch({ user: userId, force: true }).catch(() => null)
    : null;

  if (member) {
    return userProfileLabel(userId, member.displayName || member.user?.globalName || member.user?.username);
  }

  const user = await client.users.fetch(userId).catch(() => null);
  if (user) {
    return userProfileLabel(userId, user.globalName || user.username);
  }

  return userProfileLabel(userId);
}

function userProfileLabel(userId, name = null) {
  const displayName = cleanDisplayName(name || 'User');
  return `[@${displayName}](https://discord.com/users/${userId})`;
}

function cleanDisplayName(value) {
  const cleaned = String(value || 'User')
    .replace(/[\[\]()`*_~<>|]/g, '')
    .trim();

  return cleaned.slice(0, 80) || 'User';
}

function safeFileName(value) {
  return String(value || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

async function waitForUserMessage(interaction) {
  if (!interaction.channel?.isTextBased()) return null;

  const collected = await interaction.channel.awaitMessages({
    filter: (message) => message.author.id === interaction.user.id && !message.author.bot,
    max: 1,
    time: PROMPT_TIMEOUT_MS,
    errors: []
  });

  return collected.first() || null;
}

async function imageFromMessage(message) {
  const attachment = message.attachments.find((item) => item.contentType?.startsWith('image/') || looksLikeImageUrl(item.url));
  const url = attachment?.url || firstUrl(message.content);

  if (!url) throw new Error('No image found.');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const contentType = (response.headers.get('content-type') || attachment?.contentType || 'image/png').split(';')[0].toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType
  };
}

function normalizeHexColor(value) {
  const normalized = String(value || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(normalized) ? `#${normalized.toUpperCase()}` : null;
}

function hexToNumber(value) {
  const normalized = normalizeHexColor(value);
  return normalized ? Number.parseInt(normalized.slice(1), 16) : null;
}

function extractId(value) {
  return String(value || '').match(/\d{15,25}/)?.[0] || null;
}

async function resolveGuildMember(guild, value) {
  const query = cleanUserQuery(value);
  if (!query) return { member: null, ambiguous: false };

  const id = extractId(query);
  if (id) {
    const member = await guild.members.fetch(id).catch(() => null);
    return { member, ambiguous: false };
  }

  const candidates = new Map();
  const fetched = await guild.members.fetch({ query, limit: 10 }).catch(() => null);
  if (fetched) {
    for (const member of fetched.values()) candidates.set(member.id, member);
  }

  for (const member of guild.members.cache.values()) {
    if (memberMatchesQuery(member, query)) candidates.set(member.id, member);
  }

  const matches = [...candidates.values()];
  const exactMatches = matches.filter((member) => memberMatchesQuery(member, query, true));
  if (exactMatches.length === 1) return { member: exactMatches[0], ambiguous: false };
  if (exactMatches.length > 1) return { member: null, ambiguous: true };
  if (matches.length === 1) return { member: matches[0], ambiguous: false };
  return { member: null, ambiguous: matches.length > 1 };
}

function cleanUserQuery(value) {
  return String(value || '')
    .trim()
    .replace(/^<@!?(\d+)>$/, '$1')
    .replace(/^@+/, '')
    .trim();
}

function memberMatchesQuery(member, query, exact = false) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return false;

  return memberSearchValues(member).some((value) => {
    const normalizedValue = normalizeSearchText(value);
    return exact ? normalizedValue === normalizedQuery : normalizedValue.includes(normalizedQuery);
  });
}

function memberSearchValues(member) {
  return [
    member.id,
    member.displayName,
    member.nickname,
    member.user?.username,
    member.user?.globalName,
    member.user?.tag
  ].filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || '').trim().replace(/^@+/, '').toLocaleLowerCase();
}

function firstUrl(text) {
  return String(text || '').match(/https?:\/\/\S+/i)?.[0] || null;
}

function looksLikeImageUrl(url) {
  try {
    const parsed = new URL(url);
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some((extension) => parsed.pathname.toLowerCase().endsWith(extension));
  } catch {
    return false;
  }
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text || 'فارغ';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function deleteQuietly(message) {
  await message.delete().catch(() => null);
}

async function deferHidden(interaction) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply(interaction.guild ? { flags: EPHEMERAL } : {});
}

function hiddenPayload(interaction, payload) {
  const data = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (interaction.guild) data.flags = EPHEMERAL;
  return data;
}

async function replyHidden(interaction, payload) {
  const data = hiddenPayload(interaction, payload);

  if (interaction.deferred) {
    const { flags, ...editable } = data;
    await interaction.editReply(editable);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(data);
    return;
  }

  await interaction.reply(data);
}

async function followHidden(interaction, payload) {
  await interaction.followUp(hiddenPayload(interaction, payload));
}

function acquireSingleInstanceLock() {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });

  try {
    const existingPid = Number(fsSync.readFileSync(LOCK_PATH, 'utf8').trim());
    if (existingPid && isProcessAlive(existingPid)) {
      console.error(`Zajil is already running with PID ${existingPid}.`);
      return false;
    }
    fsSync.rmSync(LOCK_PATH, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[lock] stale lock check failed:', error.message);
  }

  try {
    fsSync.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
  } catch (error) {
    console.error('[lock] could not acquire instance lock:', error.message);
    return false;
  }

  process.on('exit', releaseSingleInstanceLock);
  return true;
}

function releaseSingleInstanceLock() {
  try {
    const lockPid = Number(fsSync.readFileSync(LOCK_PATH, 'utf8').trim());
    if (lockPid === process.pid) fsSync.rmSync(LOCK_PATH, { force: true });
  } catch {}
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

process.on('unhandledRejection', (error) => console.error('[process] unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('[process] uncaught exception:', error));

if (!acquireSingleInstanceLock()) {
  process.exit(1);
}

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. انسخ .env.example إلى .env وحط توكن البوت.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('Bot login failed:', error.message);
  process.exit(1);
});
