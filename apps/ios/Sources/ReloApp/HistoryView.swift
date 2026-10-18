import ReloCore
import SwiftUI

struct HistoryView: View {
    @Bindable var model: AppModel
    @State private var state = InboxHistoryPresentationState(defaultFilterIdentifier: ReloHistoryFilter.all.rawValue)
    @AppStorage(ReloHistoryPreferences.retentionKey) private var retentionRaw = HistoryRetention.standard.rawValue
    @AppStorage(ReloHistoryPreferences.clearedAtKey) private var clearedAt: Double = 0
    @State private var projectID: String?
    @State private var sourceID: String?
    @State private var origin: String?
    private var kind: ReloHistoryFilter { ReloHistoryFilter(rawValue: state.filterIdentifier) ?? .all }
    private var since: Date? {
        ReloHistoryPreferences.since(retention: retentionRaw, clearedAt: clearedAt, now: model.attentionDate)
    }
    private var results: [InboxItem] {
        let since = since, now = model.attentionDate
        return HistoryRowProjection.filter(ReloHistoryResults.make(items: model.historyItems, query: state.searchQuery, kind: kind, projectID: projectID), origin: origin)
            .filter { InboxSourceProjection.matches($0, sourceID: sourceID) && HistoryRetention.isVisible($0, since: since, now: now) }
    }
    /// Once loaded history reaches past the cutoff, older pages would only hold hidden items.
    private var olderPagesHidden: Bool {
        guard let since, let oldest = model.historyItems.map({ $0.activitySummary?.updatedAt ?? $0.createdAt }).min() else { return false }
        return oldest < since
    }
    private var visible: [InboxItem] { Array(results.prefix(state.visibleLimit)) }
    private var allRows: [HistoryRow] {
        HistoryRowProjection.rows(visible, events: model.historyItems, now: model.attentionDate)
    }
    /// Computers and accounts in the loaded history; the chip row only appears when there is a choice.
    private var origins: [String] {
        HistoryRowProjection.origins(HistoryRowProjection.rows(
            InboxHistoryProjection.collapsedActivities(model.historyItems),
            events: model.historyItems, now: model.attentionDate))
    }
    private var days: [(date: Date, rows: [HistoryRow])] {
        let rows = allRows
        return Dictionary(grouping: rows) { Calendar.current.startOfDay(for: $0.at) }
            .map { (date: $0.key, rows: $0.value) }.sorted { $0.date > $1.date }
    }
    private var filtered: Bool { !state.searchQuery.isEmpty || kind != .all || projectID != nil || sourceID != nil || origin != nil }
    var body: some View {
        List {
            Section {
                filterBar
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                if origins.count > 1 || origin != nil { originBar.listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
            } footer: {
                if filtered {
                    Text(results.count == 1 ? "1 match" : "\(results.count) matches")
                        .monospacedDigit().contentTransition(.numericText(value: Double(results.count)))
                }
            }
            if visible.isEmpty {
                ReloEmptyState(title: filtered ? "No matches" : since == nil ? "No history yet" : "Nothing recent",
                    detail: filtered ? "Try another search, or clear the filters."
                    : since == nil ? "Notifications and finished work from your sessions and scripts collect here."
                    : "Older notifications are hidden on this iPhone. Choose how long to keep them in Settings.",
                    symbol: filtered ? "magnifyingglass" : "clock")
                    .listRowBackground(Color.clear)
            } else {
                ForEach(days, id: \.date) { day in
                    Section {
                        ForEach(day.rows) { row in
                            self.row(row).listRowBackground(ReloListRowBackground())
                        }
                    } header: {
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(dayTitle(day.date)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                                Spacer(minLength: 8)
                                Text(HistoryRowProjection.daySummary(day.rows, now: model.attentionDate))
                                    .font(.caption).foregroundStyle(Color.reloSecondaryText).fixedSize()
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(dayTitle(day.date)).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                                Text(HistoryRowProjection.daySummary(day.rows, now: model.attentionDate))
                                    .font(.caption).foregroundStyle(Color.reloSecondaryText)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .textCase(nil)
                    }
                }
            }
            if case let .offline(message) = model.historyLoadState {
                Section {
                    Label(message, systemImage: "wifi.slash").font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                }.listRowBackground(ReloListRowBackground())
            }
            if visible.count < results.count || (model.historyHasMore && !olderPagesHidden) {
                Section {
                    Button {
                        if visible.count < results.count { state.showMore(available: results.count) }
                        else { Task { await model.loadOlderHistory() } }
                    } label: {
                        HStack {
                            Text(model.isLoadingHistory ? "Loading older notifications…" : paginationLabel)
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            if model.isLoadingHistory { ProgressView() }
                        }.frame(minHeight: 28)
                    }.disabled(model.isLoadingHistory).tint(.reloInteractive)
                }.listRowBackground(ReloListRowBackground())
            }
            if !model.historyItems.isEmpty {
                Section { } footer: { Text(coverage) }
            }
        }
        .listStyle(.insetGrouped).listSectionSpacing(ReloLayout.itemSpacing).reloGroupedScreen()
        .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $state.searchQuery, prompt: "Search notifications")
        .reloRefreshable { _ = await model.refresh() }
        .onAppear { state.transition(to: model.presentationScopeIdentity) }
        .onChange(of: model.presentationScopeIdentity) { _, scope in state.transition(to: scope); projectID = nil; sourceID = nil; origin = nil }
        .onChange(of: state.searchQuery) { _, _ in state.resetPagination() }
        .onChange(of: state.filterIdentifier) { _, _ in state.resetPagination() }
        .onChange(of: projectID) { _, _ in state.resetPagination() }
        .onChange(of: origin) { _, _ in state.resetPagination() }
        .onChange(of: sourceID) { _, _ in state.resetPagination(); projectID = nil }
    }
    /// Pills, not a hidden menu: the active filters are always visible and one tap to undo.
    private var filterBar: some View {
        let sources = InboxSourceProjection.groups(for: model.historyItems)
        let projects = InboxHierarchyProjection.projectOptions(for: model.historyItems)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if filtered {
                    Button {
                        withAnimation(.snappy) {
                            state.searchQuery = ""; state.filterIdentifier = ReloHistoryFilter.all.rawValue
                            projectID = nil; sourceID = nil; origin = nil
                        }
                    } label: {
                        Image(systemName: "xmark").font(.caption.weight(.bold))
                            .frame(width: 34, height: 34)
                            .background { Circle().fill(Color.white.opacity(0.08)) }
                            .overlay { Circle().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear all filters")
                    .transition(.scale.combined(with: .opacity))
                }
                ForEach(ReloHistoryFilter.allCases) { option in
                    ReloFilterPill(title: option.rawValue, symbol: option == .all ? nil : option.symbol,
                                   selected: kind == option) {
                        withAnimation(.snappy) { state.filterIdentifier = option.rawValue }
                    }
                }
                if sources.count > 1 {
                    Menu {
                        Picker("Source", selection: $sourceID) {
                            Text("All sources").tag(String?.none)
                            ForEach(sources) { Label($0.source.name, systemImage: $0.source.systemImageName).tag(Optional($0.id)) }
                        }
                    } label: {
                        ReloFilterPill(title: sources.first { $0.id == sourceID }?.source.name ?? "Source",
                                       symbol: "person.crop.circle", selected: sourceID != nil, menu: true) {}
                    }
                    .accessibilityLabel("Filter by source")
                }
                if projects.count > 1 {
                    Menu {
                        Picker("Project", selection: $projectID) {
                            Text("All projects").tag(String?.none)
                            ForEach(projects) { Text($0.name).tag(Optional($0.id)) }
                        }
                    } label: {
                        ReloFilterPill(title: projects.first { $0.id == projectID }?.name ?? "Project",
                                       symbol: "folder", selected: projectID != nil, menu: true) {}
                    }
                    .accessibilityLabel("Filter by project")
                }
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.vertical, 4)
        }
        .scrollClipDisabled()
        .sensoryFeedback(.selection, trigger: "\(kind.rawValue)|\(sourceID ?? "")|\(projectID ?? "")")
    }

    /// All · each computer or account, one tap to narrow the list.
    private var originBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ReloFilterPill(title: "All", symbol: nil, selected: origin == nil) {
                    withAnimation(.snappy) { origin = nil }
                }
                ForEach(origins, id: \.self) { name in
                    ReloFilterPill(title: name, symbol: model.computerIcon(forOrigin: name).systemImageName, selected: origin == name) {
                        withAnimation(.snappy) { origin = origin == name ? nil : name }
                    }
                }
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.vertical, 4)
        }
        .scrollClipDisabled()
        .accessibilityLabel("Filter by computer")
    }

    private var paginationLabel: String {
        if case .offline = model.historyLoadState, visible.count >= results.count { return "Retry loading older notifications" }
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
        return sameYear ? date.formatted(.dateTime.weekday(.wide).month(.wide).day())
            : date.formatted(.dateTime.month(.wide).day().year())
    }
    private func row(_ row: HistoryRow) -> some View {
        Button { Task { await model.openNotification(notificationID: row.id) } } label: {
            HistoryRowView(row: row, showsSource: sourceID == nil, showsProject: projectID == nil,
                           responseStatus: model.responseFeedback(for: row.id)?.status,
                           serverOutcome: model.nowSummary?.allItems.first { $0.notificationId == row.id }
                               .flatMap(ReloStateStyle.init(item:)),
                           computerIcon: model.computerIcon(forOrigin: row.origin))
        }.buttonStyle(.plain)
    }
}
