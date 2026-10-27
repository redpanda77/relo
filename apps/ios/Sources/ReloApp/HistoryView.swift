import ReloCore
import SwiftUI

/// What is over, as a timeline: today's count and hourly bars on top, whose counts filter the list, then each day's
/// rows on a rail with the day pinned while it scrolls. Sideways, the day's summary and a list of days sit beside it.
struct HistoryView: View {
    @Bindable var model: AppModel
    @State private var state = InboxHistoryPresentationState(defaultFilterIdentifier: ReloHistoryFilter.all.rawValue)
    @AppStorage(ReloHistoryPreferences.retentionKey) private var retentionRaw = HistoryRetention.standard.rawValue
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    @State private var projectID: String?
    @State private var sourceID: String?
    @State private var origin: String?
    /// One meaning from the counts (done, stopped, messages): a tap on its chip narrows the list to it.
    @State private var signal: NowSignal?
    @State private var showsFilters = false
    /// The day the side panel describes when sideways: the one picked from its list, else today.
    @State private var focusDay: Date?
    /// Scrolled well past the top, so the way back to today shows.
    @State private var scrolledAway = false
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private static let top = "history-top"

    private var kind: ReloHistoryFilter { ReloHistoryFilter(rawValue: state.filterIdentifier) ?? .all }
    private var since: Date? {
        ReloHistoryPreferences.since(retention: retentionRaw, clearedAt: clearedAt, now: model.attentionDate)
    }
    /// The search text the page is built from: it follows typing after a short pause, so each keystroke does not
    /// project the whole history again.
    @State private var searchedQuery = ""
    @State private var pageCache = HistoryPageCache()

    /// Everything the screen lists, worked out once per change of its inputs and not once per read: the old computed
    /// properties projected every loaded item again for each of the several reads in one body.
    private var page: HistoryPage {
        let now = model.attentionDate
        let key = HistoryPage.Key(
            items: model.historyItems, query: searchedQuery, kind: kind, projectID: projectID, sourceID: sourceID,
            origin: origin, signal: signal, retention: retentionRaw, clearedAt: clearedAt, limit: state.visibleLimit,
            minute: Int(now.timeIntervalSince1970 / 60),
            computers: model.devices.computers.map { "\($0.client.name)|\($0.client.icon?.rawValue ?? "")" })
        return pageCache.page(for: key) { HistoryPage.make(key, now: now, since: since, model: model) }
    }
    /// Narrowed by something other than a count chip: the summary gives way to the filters that are on.
    private var narrowed: Bool { !state.searchQuery.isEmpty || kind != .all || projectID != nil || sourceID != nil || origin != nil }
    private var filtered: Bool { narrowed || signal != nil }
    private var filtersOn: Int { [kind != .all, projectID != nil, sourceID != nil, origin != nil, signal != nil].filter { $0 }.count }
    private var sideways: Bool { verticalSizeClass == .compact }

    var body: some View {
        let page = page
        let all = page.all
        ScrollViewReader { proxy in
            Group {
                if sideways { besideTimeline(page, proxy: proxy) } else { upright(page, proxy: proxy) }
            }
        }
        .navigationTitle("History").navigationBarTitleDisplayMode(sideways ? .inline : .large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showsFilters = true } label: {
                    Image(systemName: filtersOn > 0 ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                }
                .tint(filtersOn > 0 ? .reloInteractive : .primary)
                .accessibilityLabel(filtersOn > 0 ? "Filters, \(filtersOn) on" : "Filters")
            }
        }
        .searchable(text: $state.searchQuery, prompt: "Search history")
        .sheet(isPresented: $showsFilters) {
            HistoryFilterSheet(model: model, kind: $state.filterIdentifier, signal: $signal, projectID: $projectID,
                               sourceID: $sourceID, origin: $origin, origins: page.origins, counts: page.counts,
                               matches: page.resultsCount, reset: clearFilters)
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .reloScreenBackground()
        .onAppear { state.transition(to: model.presentationScopeIdentity) }
        .onChange(of: model.presentationScopeIdentity) { _, scope in state.transition(to: scope); clearFilters() }
        .onChange(of: state.searchQuery) { _, _ in state.resetPagination() }
        .task(id: state.searchQuery) {
            let query = state.searchQuery
            if !query.isEmpty {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
            }
            searchedQuery = query
        }
        .onChange(of: state.filterIdentifier) { _, _ in state.resetPagination() }
        .onChange(of: projectID) { _, _ in state.resetPagination() }
        .onChange(of: origin) { _, _ in state.resetPagination() }
        .onChange(of: signal) { _, _ in state.resetPagination() }
        .onChange(of: sourceID) { _, _ in state.resetPagination(); projectID = nil }
        .sensoryFeedback(.selection, trigger: "\(kind.rawValue)|\(sourceID ?? "")|\(projectID ?? "")|\(origin ?? "")|\(signal?.rawValue ?? -1)")
    }

    // MARK: Layouts

    private func upright(_ page: HistoryPage, proxy: ScrollViewProxy) -> some View {
        let all = page.all
        let today = HistoryTimeline.activity(all, on: model.attentionDate, now: model.attentionDate)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Color.clear.frame(height: 0).id(Self.top)
                if !narrowed, !today.isEmpty {
                    HistorySummaryPanel(title: "Today", activity: today, showsNow: true, selected: $signal)
                        .padding(.top, 4).padding(.bottom, 20)
                }
                if narrowed { activeFilters(matches: page.resultsCount).padding(.top, 4) }
                timeline(page)
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.bottom, 28)
        }
        .modifier(ScrolledAwayTracker(scrolledAway: $scrolledAway))
        .overlay(alignment: .bottomTrailing) {
            if scrolledAway {
                Button { withAnimation(.snappy) { proxy.scrollTo(Self.top, anchor: .top) } } label: {
                    Label("Today", systemImage: "arrow.up").font(.subheadline.weight(.bold))
                        .foregroundStyle(Color.reloCanvas)
                        .padding(.horizontal, 14).frame(minHeight: 40)
                        .background { Capsule().fill(Color.reloInteractive) }
                        .shadow(color: .black.opacity(0.35), radius: 10, y: 5)
                }
                .buttonStyle(.plain)
                .padding(ReloLayout.screenInset)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("Back to today")
            }
        }
        .reloRefreshable { _ = await model.refresh() }
    }

    /// Sideways: the day's summary and the days to jump to on the left, the timeline scrolling on the right.
    private func besideTimeline(_ page: HistoryPage, proxy: ScrollViewProxy) -> some View {
        let all = page.all
        let now = model.attentionDate
        let calendar = Calendar.current
        let focus = focusDay ?? calendar.startOfDay(for: now)
        let dayList = Array(Set(all.map { calendar.startOfDay(for: $0.at) })).sorted(by: >).prefix(7)
        return HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HistorySummaryPanel(title: dayTitle(focus), activity: HistoryTimeline.activity(all, on: focus, now: now),
                                        showsNow: calendar.isDate(focus, inSameDayAs: now), selected: $signal, compact: true)
                    VStack(spacing: 2) {
                        ForEach(Array(dayList), id: \.self) { day in
                            let picked = calendar.isDate(day, inSameDayAs: focus)
                            Button {
                                focusDay = day
                                withAnimation(.snappy) { proxy.scrollTo(day, anchor: .top) }
                            } label: {
                                HStack {
                                    Text(dayTitle(day)).fontWeight(picked ? .semibold : .regular)
                                    Spacer()
                                    Text(all.filter { calendar.isDate($0.at, inSameDayAs: day) }.count.formatted())
                                        .font(.system(.footnote, design: .monospaced)).monospacedDigit()
                                }
                                .font(.subheadline)
                                .foregroundStyle(picked ? Color.primary : Color.reloSecondaryText)
                                .padding(.horizontal, 10).frame(minHeight: 36)
                                .background { RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(picked ? 0.08 : 0)) }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(picked ? .isSelected : [])
                        }
                    }
                }
                .padding(.vertical, 8)
                .padding(.horizontal, ReloLayout.screenInset)
            }
            .frame(width: 300)
            Rectangle().fill(Color.white.opacity(0.07)).frame(width: 0.5).ignoresSafeArea(edges: .bottom)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if filtered { activeFilters(matches: page.resultsCount).padding(.top, 8) }
                    timeline(page)
                }
                .padding(.horizontal, ReloLayout.screenInset)
                .padding(.bottom, 24)
            }
            .reloRefreshable { _ = await model.refresh() }
        }
    }

    // MARK: Timeline

    @ViewBuilder
    private func timeline(_ page: HistoryPage) -> some View {
        if page.visibleCount == 0 {
            ReloEmptyState(title: filtered ? "No matches" : since == nil ? "No history yet" : "Nothing recent",
                detail: filtered ? "Try another search, or clear the filters."
                : since == nil ? "Notifications and finished work from your sessions and scripts collect here."
                : "Older notifications are hidden on this iPhone. Choose how long to keep them in Settings.",
                symbol: filtered ? "magnifyingglass" : "clock")
                .padding(.top, 40)
        } else {
            ForEach(page.days, id: \.date) { day in
                Section {
                    ForEach(Array(day.rows.enumerated()), id: \.element.id) { index, row in
                        let newer = index > 0 ? day.rows[index - 1] : nil
                        let older = index + 1 < day.rows.count ? day.rows[index + 1] : nil
                        self.row(row, icons: page.icons, showsDayHalf: newer.map { HistoryClock.dayHalf($0.at) != HistoryClock.dayHalf(row.at) } ?? true,
                                 continues: older != nil)
                            // Room under a day's band lives with its first row: a pinned band stays one solid strip.
                            .padding(.top, index == 0 && !Calendar.current.isDateInToday(day.date) ? 16 : 0)
                        if let older, let gap = HistoryTimeline.quietGap(newer: row.at, older: older.at) {
                            HistoryQuietGap(text: gap)
                        }
                    }
                } header: {
                    // Today needs no band: the Today panel above already names it and counts it.
                    if !Calendar.current.isDateInToday(day.date) { dayHeader(day.date, rows: day.rows) }
                }
                .id(day.date)
            }
        }
        if case let .offline(message) = model.historyLoadState {
            Label(message, systemImage: "wifi.slash").font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                .padding(.vertical, 12)
        }
        if page.visibleCount < page.resultsCount || (model.historyHasMore && !page.olderPagesHidden) {
            Button {
                if page.visibleCount < page.resultsCount { state.showMore(available: page.resultsCount) }
                else { Task { await model.loadOlderHistory() } }
            } label: {
                HStack(spacing: 10) {
                    Text(model.isLoadingHistory ? "Loading older notifications…" : paginationLabel(page))
                        .font(.subheadline.weight(.semibold))
                    if model.isLoadingHistory { ProgressView() }
                }
                .padding(.horizontal, 16).frame(minHeight: 44)
                .background { Capsule().fill(Color.white.opacity(0.06)) }
                .overlay { Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75) }
            }
            .buttonStyle(.plain).foregroundStyle(Color.reloInteractive)
            .disabled(model.isLoadingHistory)
            .padding(.top, 4)
        }
        if !model.historyItems.isEmpty {
            Text(coverage).font(.caption).foregroundStyle(Color.reloSecondaryText).padding(.top, 12)
        }
    }

    /// An earlier day, pinned while its rows scroll: its name and date, and how it went.
    private func dayHeader(_ date: Date, rows: [HistoryRow]) -> some View {
        let counts = HistoryTimeline.counts(rows)
            .map { "\($0.count) \(HistoryTimeline.countLabel($0.signal, count: $0.count).lowercased())" }
            .joined(separator: " · ")
        let name = Text(dayTitle(date)).font(.title3.weight(.bold))
            + Text("  " + date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
                .font(.footnote).foregroundColor(.reloSecondaryText)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                name.lineLimit(1)
                Spacer(minLength: 8)
                Text(counts).font(.footnote).foregroundStyle(Color.reloSecondaryText).lineLimit(1).fixedSize()
            }
            VStack(alignment: .leading, spacing: 2) {
                name
                Text(counts).font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, ReloLayout.screenInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
        .padding(.horizontal, -ReloLayout.screenInset)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    /// The filters that are on, each one tap to undo, and how many rows are left.
    private func activeFilters(matches: Int) -> some View {
        HistoryChipFlow(spacing: 8) {
            ForEach(activeFilterChips, id: \.title) { chip in
                Button(action: chip.clear) {
                    HStack(spacing: 6) {
                        Text(chip.title).lineLimit(1)
                        Image(systemName: "xmark").font(.caption2.weight(.bold))
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.reloInteractive)
                    .padding(.horizontal, 12).frame(minHeight: 34)
                    .background { Capsule().fill(Color.reloInteractive.opacity(0.14)) }
                    .overlay { Capsule().strokeBorder(Color.reloInteractive.opacity(0.5), lineWidth: 0.75) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove filter \(chip.title)")
            }
            Text(matches == 1 ? "1 match" : "\(matches) matches")
                .font(.subheadline).foregroundStyle(Color.reloSecondaryText).monospacedDigit()
                .frame(minHeight: 34)
                .contentTransition(.numericText(value: Double(matches)))
        }
        .animation(.snappy, value: filtersOn)
    }

    private struct FilterChip { let title: String; let clear: () -> Void }

    private var activeFilterChips: [FilterChip] {
        var chips: [FilterChip] = []
        if !state.searchQuery.isEmpty { chips.append(FilterChip(title: "“\(state.searchQuery)”", clear: { state.searchQuery = "" })) }
        if kind != .all { chips.append(FilterChip(title: HistoryFilterSheet.title(kind), clear: { state.filterIdentifier = ReloHistoryFilter.all.rawValue })) }
        if let signal { chips.append(FilterChip(title: HistoryTimeline.countLabel(signal, count: 2), clear: { self.signal = nil })) }
        if let origin { chips.append(FilterChip(title: origin, clear: { self.origin = nil })) }
        if let sourceID {
            let name = InboxSourceProjection.groups(for: model.historyItems).first { $0.id == sourceID }?.source.name ?? "Source"
            chips.append(FilterChip(title: name, clear: { self.sourceID = nil }))
        }
        if let projectID {
            let name = InboxHierarchyProjection.projectOptions(for: model.historyItems).first { $0.id == projectID }?.name ?? "Project"
            chips.append(FilterChip(title: name, clear: { self.projectID = nil }))
        }
        return chips
    }

    private func clearFilters() {
        withAnimation(.snappy) {
            state.searchQuery = ""; state.filterIdentifier = ReloHistoryFilter.all.rawValue
            projectID = nil; sourceID = nil; origin = nil; signal = nil
        }
    }

    private func paginationLabel(_ page: HistoryPage) -> String {
        if case .offline = model.historyLoadState, page.visibleCount >= page.resultsCount { return "Retry loading older notifications" }
        return "Load older notifications"
    }
    private var coverage: String {
        let count = model.historyItems.count
        if let since {
            let window = ReloHistoryPreferences.retention(retentionRaw)
            let cleared = clearedAt > 0 && Date(timeIntervalSince1970: clearedAt) >= since
            return cleared ? "Showing notifications since you cleared history · change this in Settings"
                : "Showing the last \(window.label) · change this in Settings"
        }
        if !model.historyIsServerBacked { return "\(count) saved notifications · searching offline" }
        if model.historyHasMore { return "Showing the latest \(count) of \(model.historyTotal ?? count) notifications" }
        if count != model.historyTotal ?? count { return "\(count) notifications · pull to refresh" }
        return "\(count) notifications"
    }
    private func dayTitle(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let sameYear = calendar.isDate(date, equalTo: .now, toGranularity: .year)
        return sameYear ? date.formatted(.dateTime.weekday(.wide)) : date.formatted(.dateTime.month(.wide).day().year())
    }
    private func row(_ row: HistoryRow, icons: [String: ComputerIcon], showsDayHalf: Bool, continues: Bool) -> some View {
        Button { Task { await model.openNotification(notificationID: row.id) } } label: {
            HistoryRowView(row: row, showsDayHalf: showsDayHalf, continues: continues, showsProject: projectID == nil,
                           responseStatus: model.responseFeedback(for: row.id)?.status,
                           serverOutcome: model.nowItemsByNotificationID[row.id].flatMap(ReloStateStyle.init(item:)),
                           computerIcon: row.origin.flatMap { icons[$0] } ?? .laptop)
        }
        .buttonStyle(HistoryRowButtonStyle())
    }
}

// MARK: - Page

/// One memoized answer to "what does History list?": the settled rows, the filtered result count, the visible days
/// (each row built once) and what the filter sheet offers. `HistoryView` keeps it by the inputs' key.
struct HistoryPage {
    struct Key: Equatable {
        var items: [InboxItem]
        var query: String
        var kind: ReloHistoryFilter
        var projectID: String?
        var sourceID: String?
        var origin: String?
        var signal: NowSignal?
        var retention: String
        var clearedAt: Double
        var limit: Int
        /// Time moves the page on by the minute, as the rows' words do.
        var minute: Int
        /// The account's computers (name and icon), which pick each origin's icon.
        var computers: [String]
    }

    /// Every settled row loaded, filters aside: today's count and the day panels read these, as Now's TODAY does.
    var all: [HistoryRow] = []
    var resultsCount = 0
    var visibleCount = 0
    var days: [(date: Date, rows: [HistoryRow])] = []
    var origins: [String] = []
    var counts: [HistoryTimeline.Count] = []
    var icons: [String: ComputerIcon] = [:]
    /// Once loaded history reaches past the cutoff, older pages would only hold hidden items.
    var olderPagesHidden = false

    @MainActor
    static func make(_ key: Key, now: Date, since: Date?, model: AppModel) -> HistoryPage {
        var page = HistoryPage()
        let history = key.items.filter { key.clearedAt <= 0 || $0.createdAt.timeIntervalSince1970 >= key.clearedAt }
        page.all = HistoryRowProjection.rows(InboxHistoryProjection.readable(history), events: history, now: now)
            .filter(\.outcome.isSettled)
        // The settled rows already hold each item's outcome: filtering reuses them instead of projecting again.
        let settled = Dictionary(page.all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let signal = key.signal
        let results = HistoryRowProjection.filter(
            ReloHistoryResults.make(items: key.items, query: key.query, kind: key.kind, projectID: key.projectID),
            origin: key.origin)
            .filter { InboxSourceProjection.matches($0, sourceID: key.sourceID) && HistoryRetention.isVisible($0, since: since, now: now) }
            // Ongoing work (running, or waiting for you) is Now's; History is what is over.
            .filter {
                let row = settled[$0.id] ?? HistoryRowProjection.row($0, now: now)
                return row.outcome.isSettled && signal.map { HistoryTimeline.signal(row) == $0 } != false
            }
        let visible = Array(results.prefix(key.limit))
        let rows = HistoryRowProjection.rows(visible, events: key.items, now: now)
        page.resultsCount = results.count
        page.visibleCount = visible.count
        page.days = Dictionary(grouping: rows) { Calendar.current.startOfDay(for: $0.at) }
            .map { (date: $0.key, rows: $0.value.sorted { $0.at > $1.at }) }.sorted { $0.date > $1.date }
        page.origins = HistoryRowProjection.origins(page.all)
        page.counts = HistoryTimeline.counts(page.all)
        for origin in Set(rows.compactMap(\.origin)) { page.icons[origin] = model.computerIcon(forOrigin: origin) }
        if let since, let oldest = key.items.map({ $0.activitySummary?.updatedAt ?? $0.createdAt }).min() {
            page.olderPagesHidden = oldest < since
        }
        return page
    }
}

/// Holds the last page and the key it was built for. Not observed: it only remembers, so reading it in a body
/// never invalidates anything.
@MainActor
final class HistoryPageCache {
    private var key: HistoryPage.Key?
    private var page = HistoryPage()

    func page(for key: HistoryPage.Key, build: () -> HistoryPage) -> HistoryPage {
        if self.key == key { return page }
        page = build()
        self.key = key
        return page
    }
}

// MARK: - Summary

/// The day at a glance: how many things settled, by hour and meaning, and one chip per meaning that narrows the list.
struct HistorySummaryPanel: View {
    let title: String
    let activity: TodayActivity
    /// Marks the current hour; an earlier day has none.
    let showsNow: Bool
    @Binding var selected: NowSignal?
    /// Sideways: a shorter chart and the counts as a list.
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .bottom, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.footnote.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
                    Text(activity.rows.count.formatted())
                        .font(.system(size: compact ? 28 : 34, weight: .bold)).monospacedDigit()
                        .contentTransition(.numericText(value: Double(activity.rows.count)))
                }
                .padding(.bottom, 14)
                .accessibilityElement(children: .combine)
                VStack(spacing: 5) {
                    bars
                    HStack(spacing: 0) {
                        ForEach(HistoryClock.axis, id: \.self) { mark in
                            Text(mark).font(.system(size: 10, design: .monospaced)) // design: chart axis text
                                .foregroundStyle(Color.reloSecondaryText).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .accessibilityHidden(true)
                }
            }
            Rectangle().fill(Color.white.opacity(0.07)).frame(height: 0.5)
                .padding(.horizontal, -14).padding(.top, 12).padding(.bottom, 10)
            if compact {
                VStack(spacing: 2) { ForEach(counts, id: \.signal) { chip($0, row: true) } }
            } else {
                HistoryChipFlow(spacing: 6) { ForEach(counts, id: \.signal) { chip($0, row: false) } }
            }
        }
        .padding(14)
        .background { RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white.opacity(0.05)) }
        .overlay { RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.white.opacity(0.06), lineWidth: 0.75) }
    }

    private var counts: [HistoryTimeline.Count] { HistoryTimeline.counts(activity.rows) }

    private var bars: some View {
        let mixes = activity.hourMixes
        let height: CGFloat = compact ? 30 : 46
        let unit = (height - 4) / CGFloat(max(activity.maxTotal, 1))
        return HStack(alignment: .bottom, spacing: compact ? 1.5 : 2) {
            ForEach(mixes, id: \.hour) { mix in
                VStack(spacing: 1) {
                    ForEach(Array(NowSignal.allCases.reversed()), id: \.self) { signal in
                        if let count = mix.counts[signal], count > 0 {
                            RoundedRectangle(cornerRadius: 1.5).fill(ReloHoloTheme.color(signal).opacity(dimmed(signal) ? 0.3 : 0.9))
                                .frame(height: CGFloat(count) * unit)
                        }
                    }
                    Capsule().fill(base(mix.hour)).frame(height: 3)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: height, alignment: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Activity by hour")
        .accessibilityValue("\(activity.rows.count) items, busiest hour has \(activity.maxTotal)")
    }

    /// While one meaning is picked, the others step back in the bars too.
    private func dimmed(_ signal: NowSignal) -> Bool { selected.map { $0 != signal } ?? false }

    private func base(_ hour: Int) -> Color {
        if showsNow && hour == activity.currentHour { return .reloInteractive }
        return Color.white.opacity(showsNow && hour > activity.currentHour ? 0.04 : 0.12)
    }

    private func chip(_ entry: HistoryTimeline.Count, row: Bool) -> some View {
        let picked = selected == entry.signal
        let color = ReloHoloTheme.color(entry.signal)
        let label = HistoryTimeline.countLabel(entry.signal, count: entry.count)
        return Button {
            withAnimation(.snappy) { selected = picked ? nil : entry.signal }
        } label: {
            HStack(spacing: 7) {
                Circle().fill(color).frame(width: 8, height: 8)
                if row {
                    Text(label).foregroundStyle(picked ? Color.primary : Color.reloSecondaryText)
                    Spacer(minLength: 8)
                    Text(entry.count.formatted()).fontWeight(.bold).monospacedDigit()
                } else {
                    Text(entry.count.formatted()).fontWeight(.bold).monospacedDigit()
                    Text(label).foregroundStyle(picked ? Color.primary : Color.reloSecondaryText)
                }
            }
            .font(.subheadline)
            .padding(.horizontal, row ? 8 : 12).frame(minHeight: row ? 32 : 36)
            .background {
                if row { RoundedRectangle(cornerRadius: 9).fill(picked ? color.opacity(0.16) : .clear) }
                else { Capsule().fill(picked ? color.opacity(0.16) : Color.white.opacity(0.05)) }
            }
            .overlay {
                if !row { Capsule().strokeBorder(picked ? color.opacity(0.6) : Color.white.opacity(0.10), lineWidth: 0.75) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(entry.count) \(label)")
        .accessibilityHint(picked ? "Shows everything again" : "Shows only these")
        .accessibilityAddTraits(picked ? .isSelected : [])
    }
}

// MARK: - Filters

/// Every filter in one place, opened from the toolbar: what to show, how it ended, the computer, source and project.
struct HistoryFilterSheet: View {
    @Bindable var model: AppModel
    @Binding var kind: String
    @Binding var signal: NowSignal?
    @Binding var projectID: String?
    @Binding var sourceID: String?
    @Binding var origin: String?
    let origins: [String]
    let counts: [HistoryTimeline.Count]
    let matches: Int
    let reset: () -> Void
    @Environment(\.dismiss) private var dismiss

    static func title(_ filter: ReloHistoryFilter) -> String {
        switch filter {
        case .all: "All"
        case .activities: "Work"
        case .notifications: "Messages"
        case .decisions: "Decisions"
        case .responses: "Replies"
        }
    }

    var body: some View {
        let sources = InboxSourceProjection.groups(for: model.historyItems)
        let projects = InboxHierarchyProjection.projectOptions(for: model.historyItems)
        NavigationStack {
            Form {
                Section("Show") {
                    Picker("Show", selection: $kind) {
                        ForEach([ReloHistoryFilter.all, .activities, .notifications, .decisions], id: \.self) {
                            Text(Self.title($0)).tag($0.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                }
                if !counts.isEmpty {
                    Section("How it ended") {
                        ForEach(counts, id: \.signal) { entry in
                            check(HistoryTimeline.countLabel(entry.signal, count: entry.count), count: entry.count,
                                  dot: ReloHoloTheme.color(entry.signal), on: signal == entry.signal) {
                                signal = signal == entry.signal ? nil : entry.signal
                            }
                        }
                    }
                }
                if origins.count > 1 || origin != nil {
                    Section("Computer") {
                        check("All computers", on: origin == nil) { origin = nil }
                        ForEach(origins, id: \.self) { name in
                            check(name, symbol: model.computerIcon(forOrigin: name).systemImageName, on: origin == name) {
                                origin = origin == name ? nil : name
                            }
                        }
                    }
                }
                if sources.count > 1 {
                    Section("Source") {
                        Picker("Source", selection: $sourceID) {
                            Text("All sources").tag(String?.none)
                            ForEach(sources) { Label($0.source.name, systemImage: $0.source.systemImageName).tag(Optional($0.id)) }
                        }
                    }
                }
                if projects.count > 1 {
                    Section("Project") {
                        Picker("Project", selection: $projectID) {
                            Text("All projects").tag(String?.none)
                            ForEach(projects) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                }
            }
            .navigationTitle("Filters").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Reset", action: reset) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(matches == 1 ? "Show 1" : "Show \(matches)") { dismiss() }.fontWeight(.semibold)
                }
            }
        }
        .sensoryFeedback(.selection, trigger: "\(kind)|\(signal?.rawValue ?? -1)|\(origin ?? "")|\(sourceID ?? "")|\(projectID ?? "")")
    }

    private func check(_ title: String, count: Int? = nil, symbol: String? = nil, dot: Color? = nil, on: Bool,
                       action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let dot { Circle().fill(dot).frame(width: 9, height: 9) }
                if let symbol { Image(systemName: symbol).foregroundStyle(Color.reloSecondaryText) }
                Text(title).foregroundStyle(Color.primary)
                Spacer()
                if let count { Text(count.formatted()).foregroundStyle(Color.reloSecondaryText).monospacedDigit() }
                if on { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.reloInteractive) }
            }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - Pieces

/// A quiet stretch between two rows: the rail turns dotted and says how long nothing happened.
struct HistoryQuietGap: View {
    let text: String
    @ScaledMetric(relativeTo: .footnote) private var timeWidth: CGFloat = 46
    @ScaledMetric(relativeTo: .body) private var dot: CGFloat = 20

    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: timeWidth)
            Line().stroke(Color.primary.opacity(0.22), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [0.5, 5]))
                .frame(width: 2).frame(width: dot + 16)
            Text(text).font(.caption).foregroundStyle(Color.reloSecondaryText).padding(.leading, 4)
            Spacer(minLength: 0)
        }
        .frame(height: 30)
        .padding(.top, -14).padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            Path { $0.move(to: CGPoint(x: rect.midX, y: rect.minY)); $0.addLine(to: CGPoint(x: rect.midX, y: rect.maxY)) }
        }
    }
}

/// A row presses as a soft rounded wash behind the whole row.
private struct HistoryRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.07 : 0))
                    .padding(.horizontal, -8).padding(.top, -8)
            }
    }
}

/// Shows the way back to today once the list has scrolled well past it (iOS 18; earlier, the tab bar's tap does).
private struct ScrolledAwayTracker: ViewModifier {
    @Binding var scrolledAway: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 900 } action: { _, away in
                withAnimation(.snappy) { scrolledAway = away }
            }
        } else {
            content
        }
    }
}

/// Chips that wrap onto as many lines as they need.
struct HistoryChipFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (indices: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.indices.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.indices + [index], needed, max(current.height, size.height))
            }
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
