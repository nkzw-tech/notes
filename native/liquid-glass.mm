#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cstring>

// Only the main process passes handles obtained from BrowserWindow. No native
// pointer or view manipulation is exposed to the renderer.
static char glassAssociation;
static constexpr CGFloat glassOverscan = 64;

static CGFloat windowCornerRadius(NSWindow* window) {
  if (window.styleMask & NSWindowStyleMaskFullScreen) return 0;
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
  if (@available(macOS 27.0, *)) {
    NSViewCornerRadii* radii = window.contentView.effectiveCornerRadii;
    if (radii) return radii.topLeft;
  }
#endif
  // Older AppKit versions don't expose the effective window corner radii.
  return 16;
}

// Clear Glass changes its frosting when its window becomes key. Give the glass
// a non-activating backing panel, while Electron keeps real keyboard focus.
@interface NotesGlassPanel : NSPanel
@end

@implementation NotesGlassPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

API_AVAILABLE(macos(26.0))
@interface NotesGlassBackdrop : NSObject
@property(nonatomic, weak) NSWindow* owner;
@property(nonatomic, strong) NotesGlassPanel* panel;
@property(nonatomic, strong) NSView* clipView;
@property(nonatomic, strong) NSGlassEffectView* glass;
- (instancetype)initWithWindow:(NSWindow*)window;
- (void)synchronize:(NSNotification*)notification;
- (void)invalidate;
@end

@implementation NotesGlassBackdrop
- (instancetype)initWithWindow:(NSWindow*)window {
  self = [super init];
  if (self) {
    self.owner = window;
    self.panel = [[NotesGlassPanel alloc]
      initWithContentRect:window.frame
      styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
      backing:NSBackingStoreBuffered defer:NO];
    self.panel.releasedWhenClosed = NO;
    self.panel.opaque = NO;
    self.panel.backgroundColor = NSColor.clearColor;
    self.panel.hasShadow = NO;
    self.panel.hidesOnDeactivate = NO;
    self.panel.ignoresMouseEvents = YES;
    self.panel.excludedFromWindowsMenu = YES;
    self.panel.accessibilityHidden = YES;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorFullScreenAuxiliary;
    self.panel.appearanceSource = window;
    self.clipView = [[NSView alloc] initWithFrame:self.panel.contentView.bounds];
    self.clipView.wantsLayer = YES;
    self.clipView.clipsToBounds = YES;
    self.clipView.layer.masksToBounds = YES;
    self.clipView.layer.cornerCurve = kCACornerCurveContinuous;
    self.clipView.layer.cornerRadius = windowCornerRadius(window);
    self.panel.contentView = self.clipView;
    // Only show the flat middle of the glass. Its refractive rim and highlight
    // sit outside the clip, leaving the foreground window as the only edge.
    self.glass = [[NSGlassEffectView alloc] initWithFrame:NSInsetRect(self.clipView.bounds, -glassOverscan, -glassOverscan)];
    self.glass.style = NSGlassEffectViewStyleClear;
    self.glass.cornerRadius = 0;
    self.glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.glass.contentView = [[NSView alloc] initWithFrame:self.glass.bounds];
    [self.clipView addSubview:self.glass];

    NSNotificationCenter* notifications = NSNotificationCenter.defaultCenter;
    for (NSNotificationName name in @[
      NSWindowDidMoveNotification, NSWindowDidResizeNotification,
      NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
      NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification,
      NSWindowDidChangeOcclusionStateNotification, NSWindowDidChangeScreenNotification,
      NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
      NSWindowDidUpdateNotification
    ]) {
      [notifications addObserver:self selector:@selector(synchronize:) name:name object:window];
    }
    for (NSNotificationName name in @[NSApplicationDidHideNotification, NSApplicationDidUnhideNotification]) {
      [notifications addObserver:self selector:@selector(synchronize:) name:name object:NSApp];
    }
    [notifications addObserver:self selector:@selector(ownerWillClose:) name:NSWindowWillCloseNotification object:window];
    [self synchronize:nil];
  }
  return self;
}

- (void)synchronize:(NSNotification*)notification {
  NSWindow* owner = self.owner;
  if (!owner || !self.panel) return;
  NSView* content = owner.contentView;
  NSRect frame = [owner convertRectToScreen:[content convertRect:content.bounds toView:nil]];
  if (!NSEqualRects(self.panel.frame, frame)) [self.panel setFrame:frame display:YES];
  CGFloat radius = windowCornerRadius(owner);
  if (self.clipView.layer.cornerRadius != radius) self.clipView.layer.cornerRadius = radius;
  NSRect glassFrame = NSInsetRect(self.clipView.bounds, -glassOverscan, -glassOverscan);
  if (!NSEqualRects(self.glass.frame, glassFrame)) self.glass.frame = glassFrame;
  if (self.panel.level != owner.level) self.panel.level = owner.level;
  if (owner.isVisible && !owner.isMiniaturized && !NSApp.isHidden) {
    if (self.panel.parentWindow != owner) [owner addChildWindow:self.panel ordered:NSWindowBelow];
    if (!self.panel.isVisible) [self.panel orderWindow:NSWindowBelow relativeTo:owner.windowNumber];
  } else if (self.panel.isVisible) {
    [self.panel orderOut:nil];
  }
}

- (void)ownerWillClose:(NSNotification*)notification {
  NSWindow* owner = self.owner;
  [self invalidate];
  objc_setAssociatedObject(owner, &glassAssociation, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

- (void)invalidate {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self.panel.parentWindow removeChildWindow:self.panel];
  [self.panel orderOut:nil];
  [self.panel close];
  self.panel = nil;
  self.glass = nil;
  self.clipView = nil;
  self.owner = nil;
}

- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
@end

static napi_value fail(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static napi_value isSupported(napi_env env, napi_callback_info info) {
  bool supported = false;
  if (@available(macOS 26.0, *)) supported = true;
  napi_value result;
  napi_get_boolean(env, supported, &result);
  return result;
}

static NSWindow* windowFromHandle(napi_env env, napi_value value) {
  bool isBuffer = false;
  void* bytes = nullptr;
  size_t length = 0;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, value, &bytes, &length) != napi_ok ||
      length != sizeof(void*)) {
    fail(env, "Expected a native window handle from Electron.");
    return nil;
  }
  void* pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) {
    fail(env, "The native window handle is empty.");
    return nil;
  }
  NSView* view = (__bridge NSView*)pointer;
  NSWindow* window = view.window;
  if (!window) fail(env, "The Notes window is no longer available.");
  return window;
}

static napi_value setEnabled(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Glass must be updated on the main thread.");
  size_t argc = 2;
  napi_value args[2];
  bool enabled = false;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_bool(env, args[1], &enabled) != napi_ok) {
    return fail(env, "Expected a native window handle and an enabled flag.");
  }
  if (@available(macOS 26.0, *)) {
    @try {
      NSWindow* window = windowFromHandle(env, args[0]);
      if (!window) return nullptr;
      NotesGlassBackdrop* backdrop = objc_getAssociatedObject(window, &glassAssociation);
      if (!enabled) {
        [backdrop invalidate];
        objc_setAssociatedObject(window, &glassAssociation, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      } else {
        if (!backdrop) {
          backdrop = [[NotesGlassBackdrop alloc] initWithWindow:window];
          objc_setAssociatedObject(window, &glassAssociation, backdrop, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        [backdrop synchronize:nil];
      }
    } @catch (NSException* exception) {
      return fail(env, exception.reason.UTF8String ?: "Could not update Clear Liquid Glass.");
    }
  } else if (enabled) {
    return fail(env, "Clear Liquid Glass requires macOS 26 or later.");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

// Used by the native smoke test to verify attachment, resizing, and removal.
static napi_value inspect(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Glass must be inspected on the main thread.");
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return fail(env, "Expected a native window handle.");
  }
  NSWindow* window = windowFromHandle(env, args[0]);
  if (!window) return nullptr;
  napi_value result;
  napi_create_object(env, &result);
  if (@available(macOS 26.0, *)) {
    NotesGlassBackdrop* backdrop = objc_getAssociatedObject(window, &glassAssociation);
    NSGlassEffectView* glass = backdrop.glass;
    napi_value attached, clear, width, height;
    napi_value windowKey, backdropKey, hidden, visible, ignoresMouse, canBecomeKey, childCount, x, y;
    napi_get_boolean(env, window.isKeyWindow, &windowKey);
    napi_get_boolean(env, glass.window.isKeyWindow, &backdropKey);
    napi_get_boolean(env, glass.isHiddenOrHasHiddenAncestor, &hidden);
    napi_get_boolean(env, backdrop.panel.isVisible, &visible);
    napi_get_boolean(env, backdrop.panel.ignoresMouseEvents, &ignoresMouse);
    napi_get_boolean(env, backdrop.panel.canBecomeKeyWindow, &canBecomeKey);
    napi_create_uint32(env, (uint32_t)window.childWindows.count, &childCount);
    napi_create_double(env, backdrop.panel.frame.origin.x, &x);
    napi_create_double(env, backdrop.panel.frame.origin.y, &y);
    napi_get_boolean(env, glass != nil && glass.superview != nil, &attached);
    napi_get_boolean(env, glass != nil && glass.style == NSGlassEffectViewStyleClear, &clear);
    napi_create_double(env, backdrop.clipView.bounds.size.width, &width);
    napi_create_double(env, backdrop.clipView.bounds.size.height, &height);
    napi_set_named_property(env, result, "attached", attached);
    napi_set_named_property(env, result, "clear", clear);
    napi_set_named_property(env, result, "width", width);
    napi_set_named_property(env, result, "height", height);
    napi_set_named_property(env, result, "windowKey", windowKey);
    napi_set_named_property(env, result, "backdropKey", backdropKey);
    napi_set_named_property(env, result, "hidden", hidden);
    napi_set_named_property(env, result, "visible", visible);
    napi_set_named_property(env, result, "ignoresMouse", ignoresMouse);
    napi_set_named_property(env, result, "canBecomeKey", canBecomeKey);
    napi_set_named_property(env, result, "childCount", childCount);
    napi_set_named_property(env, result, "x", x);
    napi_set_named_property(env, result, "y", y);
    napi_value clipRadius, ownerRadius, clips, glassWidth, glassHeight, glassX, glassY;
    napi_create_double(env, backdrop.clipView.layer.cornerRadius, &clipRadius);
    napi_create_double(env, windowCornerRadius(window), &ownerRadius);
    napi_get_boolean(env, backdrop.clipView.clipsToBounds && backdrop.clipView.layer.masksToBounds, &clips);
    napi_create_double(env, glass.frame.size.width, &glassWidth);
    napi_create_double(env, glass.frame.size.height, &glassHeight);
    napi_create_double(env, glass.frame.origin.x, &glassX);
    napi_create_double(env, glass.frame.origin.y, &glassY);
    napi_set_named_property(env, result, "clipRadius", clipRadius);
    napi_set_named_property(env, result, "windowCornerRadius", ownerRadius);
    napi_set_named_property(env, result, "clipsGlass", clips);
    napi_set_named_property(env, result, "glassWidth", glassWidth);
    napi_set_named_property(env, result, "glassHeight", glassHeight);
    napi_set_named_property(env, result, "glassX", glassX);
    napi_set_named_property(env, result, "glassY", glassY);
    napi_value backdropLevel, windowLevel;
    napi_create_int64(env, backdrop.panel.level, &backdropLevel);
    napi_create_int64(env, window.level, &windowLevel);
    napi_set_named_property(env, result, "backdropLevel", backdropLevel);
    napi_set_named_property(env, result, "windowLevel", windowLevel);
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"isSupported", nullptr, isSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setEnabled", nullptr, setEnabled, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
