export const en = {
  fileSearchPartial:
    "File search is partial (scan or result limit). Try a folder/path query.",
  filesError: "Files: {{error}}",
  workspaceFilesAfterCreation:
    "Workspace files are available after this thread is created.",
  untitledThread: "Untitled thread",
  working: "Working",
  idle: "Idle",
  threadsError: "Threads: {{error}}",
  showMore: "Show more ({{count}})",
  continueMatchingResults: "Continue through matching results",
  couldNotSelectReference: "Could not select reference: {{error}}",
  addressRoomMember: "Address this room member",
  compactThisThreadsContext: "Compact this thread's context",
  appServerDefaultModelError:
    "App Server must expose exactly one visible default model",
  configuredByAppServer: "Configured by the App Server",
  chooseModelBeforeImages: "Choose a model before sending images.",
  chooseImageModel:
    "Choose a model with known image input support before sending images.",
  imageUnsupported:
    "“{{model}}” does not support image input. Remove the images or choose a model with image support.",
  imageCapabilityUnknown:
    "Image input capability for “{{model}}” is unknown. You can try sending now, test it in Models & providers, or set it manually.",
} as const;

export const zhCN = {
  fileSearchPartial:
    "文件搜索结果不完整（扫描或结果数量已达上限）。请尝试按文件夹或路径搜索。",
  filesError: "文件：{{error}}",
  workspaceFilesAfterCreation: "创建此会话后即可搜索工作区文件。",
  untitledThread: "未命名会话",
  working: "工作中",
  idle: "空闲",
  threadsError: "会话：{{error}}",
  showMore: "显示更多（{{count}}）",
  continueMatchingResults: "继续浏览匹配结果",
  couldNotSelectReference: "无法选择引用：{{error}}",
  addressRoomMember: "向此房间成员发送消息",
  compactThisThreadsContext: "压缩此会话的上下文",
  appServerDefaultModelError: "App Server 必须提供且仅提供一个可见的默认模型",
  configuredByAppServer: "由 App Server 配置",
  chooseModelBeforeImages: "发送图片前请选择模型。",
  chooseImageModel: "发送图片前请选择已确认支持图片输入的模型。",
  imageUnsupported:
    "“{{model}}”不支持图片输入。请移除图片或选择支持图片的模型。",
  imageCapabilityUnknown:
    "尚不清楚“{{model}}”是否支持图片输入。你可以现在尝试发送、在“模型与服务商”中测试，或手动设置。",
} as const;
