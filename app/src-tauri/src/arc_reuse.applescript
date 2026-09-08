on run argv
    set targetURL to item 1 of argv
    if application id "company.thebrowser.Browser" is not running then return "not_running"
    tell application id "company.thebrowser.Browser"
        with timeout of 5 seconds
            repeat with w in windows
                -- Keep private windows separate from ordinary external links.
                if incognito of w is false then
                    repeat with s in spaces of w
                        set addresses to URL of every tab of s
                        repeat with tabIndex from 1 to count of addresses
                            considering case
                                set matchesURL to ((item tabIndex of addresses) is targetURL)
                            end considering
                            if matchesURL then
                                select (tab tabIndex of s)
                                activate
                                return "reused"
                            end if
                        end repeat
                    end repeat
                end if
            end repeat
            repeat with w in windows
                if incognito of w is false then
                    tell active space of w to make new tab at end of tabs with properties {URL:targetURL}
                    -- Arc publishes a newly created tab asynchronously. Resolve it
                    -- from the collection after creation, rather than its return value.
                    repeat 20 times
                        delay 0.05
                        set addresses to URL of every tab of w
                        repeat with tabIndex from 1 to count of addresses
                            considering case
                                set matchesURL to ((item tabIndex of addresses) is targetURL)
                            end considering
                            if matchesURL then
                                select (tab tabIndex of w)
                                activate
                                return "opened"
                            end if
                        end repeat
                    end repeat
                    activate
                    return "opened"
                end if
            end repeat
        end timeout
    end tell
    return "not_found"
end run
