#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <string.h>

static NSString * const FlowHubDaemonPlist = @"cn.ac.camellia.flowhub.resource-monitor.plist";

static NSString *FlowHubStatusName(SMAppServiceStatus status) {
    switch (status) {
        case SMAppServiceStatusNotRegistered: return @"notRegistered";
        case SMAppServiceStatusEnabled: return @"enabled";
        case SMAppServiceStatusRequiresApproval: return @"requiresApproval";
        case SMAppServiceStatusNotFound: return @"notFound";
    }
    return @"unknown";
}

static NSString *FlowHubStatusMessage(SMAppServiceStatus status) {
    switch (status) {
        case SMAppServiceStatusNotRegistered: return @"尚未启用系统级进程采集。";
        case SMAppServiceStatusEnabled: return @"系统级进程采集已获准。";
        case SMAppServiceStatusRequiresApproval: return @"请在系统设置 → 通用 → 登录项中批准 FlowHub 的进程采集服务。";
        case SMAppServiceStatusNotFound: return @"当前 FlowHub 应用包未找到系统采集服务。请将包含此功能的签名版安装到“应用程序”文件夹。";
    }
    return @"无法确认系统进程采集服务状态。";
}

static int FlowHubWriteJSON(NSDictionary *value, char *output, size_t capacity) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
    if (data == nil || data.length + 1 > capacity) return -1;
    memcpy(output, data.bytes, data.length);
    output[data.length] = '\0';
    return 0;
}

int flowhub_privileged_monitor(const char *action, char *output, size_t capacity) {
    if (action == NULL || output == NULL || capacity == 0) return -1;
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            NSString *requested = [NSString stringWithUTF8String:action];
            if (requested == nil) return -1;
            SMAppService *service = [SMAppService daemonServiceWithPlistName:FlowHubDaemonPlist];
            NSError *error = nil;
            BOOL ok = YES;
            NSString *message = nil;

            if ([requested isEqualToString:@"enable"]) {
                BOOL registered = [service registerAndReturnError:&error];
                SMAppServiceStatus status = service.status;
                if (status == SMAppServiceStatusRequiresApproval) {
                    [SMAppService openSystemSettingsLoginItems];
                }
                ok = registered || status == SMAppServiceStatusRequiresApproval || status == SMAppServiceStatusEnabled;
                message = ok ? FlowHubStatusMessage(status) : (error.localizedDescription ?: FlowHubStatusMessage(status));
            } else if ([requested isEqualToString:@"disable"]) {
                BOOL unregistered = [service unregisterAndReturnError:&error];
                SMAppServiceStatus status = service.status;
                ok = unregistered || status == SMAppServiceStatusNotRegistered;
                message = ok ? FlowHubStatusMessage(status) : (error.localizedDescription ?: FlowHubStatusMessage(status));
            } else if ([requested isEqualToString:@"status"]) {
                message = FlowHubStatusMessage(service.status);
            } else {
                return -1;
            }

            return FlowHubWriteJSON(@{@"ok": @(ok), @"status": FlowHubStatusName(service.status), @"message": message}, output, capacity);
        }
        return FlowHubWriteJSON(@{@"ok": @NO, @"status": @"unsupported", @"message": @"完整进程监控需要 macOS 13 或更高版本。"}, output, capacity);
    }
}
