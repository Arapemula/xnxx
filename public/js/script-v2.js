function app() {
  console.log("Script loaded: v2 (Cache check)");
  let chartInstance = null;
  let hourlyChartInstance = null;
  return {
    // STATE
    currentPage: "chat",
    sessionId: localStorage.getItem("wa_session_id") || "",
    showGroups: JSON.parse(localStorage.getItem("wa_show_groups") ?? "true"),
    aiActive: false,
    aiHasFile: false,
    aiPrompt: `Kamu adalah Customer Service (CS) dari [NAMA TOKO ANDA].
    
Tugasmu adalah menjawab pertanyaan pelanggan dengan gaya yang:
1. PROFESIONAL tapi SANTAI: Gunakan bahasa Indonesia yang baku namun luwes. Hindari kata-kata kaku seperti "Sesuai dengan ketentuan yang berlaku". Ganti dengan "Sesuai aturan ya Kak".
2. RAMAH & EMPATIK: Selalu gunakan sapaan "Kak" atau "Sis/Gan" (sesuaikan). Gunakan emoji secukupnya (maksimal 1-2 per pesan) agar suasana cair.
3. SOLUTIF: Jangan cuma menjawab "Ya/Tidak". Berikan solusi atau rekomendasi. Jika stok habis, tawarkan alternatif.
4. TO THE POINT: Jawaban harus ringkas, jelas, dan tidak bertele-tele. Maksimal 3 paragraf pendek.

PENTING:
- Jika ditanya harga/produk, gunakan data dari konteks yang diberikan. Jangan mengarang harga.
- Jika kamu tidak tahu jawabannya, katakan: "Bentar ya Kak, aku cek dulu ke tim gudang/admin sebentar" (jangan bilang "sebagai AI saya tidak tahu").
- Tutup percakapan dengan kalimat yang memancing interaksi, misal: "Ada lagi yang bisa dibantu, Kak?"

CONTOH GAYA BICARA:
User: "Barangnya ready gak min?"
Kamu: "Halo Kak! 👋 Untuk barang itu ready stok siap kirim ya. Mau warna apa nih Kak biar aku cekin sekalian? 😊"`,
    showPromptModal: false,
    isLoggedIn: false,
    isLoading: false,
    qrCodeVal: null,
    mobileMenu: false,
    mobileActionMenu: false,
    chatList: [],
    messages: {},
    activeChat: null,
    inputText: "",
    socket: null,
    selectedFile: null,
    stats: {
      incoming: 0,
      outgoing: 0,
      aiCount: 0,
      invoiceIssued: 0,
      invoicePaid: 0,
      logs: [],
    },
    topProducts: [],
    topCustomers: [],
    topQuestions: [],
    labelDistribution: [],
    chart: null,
    analyticsInterval: null,
    showInvoiceModal: false,
    products: [],
    cart: [],
    selectedProductIndex: "",
    qtyInput: 1,
    invoiceNote: "",
    isPaid: false,
    invoiceTab: "new",
    unpaidInvoices: [],
    shippingOptions: [], // [{label: 'JNE', price: 10000}]
    messageTemplates: [], // [{shortcut: '/rek', content: '...'}]
    selectedShippingIndex: "",
    crmData: {},
    showCRMModal: false,
    tempLabel: "General",
    tempNote: "",
    showBroadcastModal: false,
    broadcastTarget: "all",
    manualNumbers: "",
    broadcastMsg: "",
    selectedMonth: "",

    // SCHEDULE STATE
    schedules: [],
    showScheduleModal: false,
    scheduleForm: {
      id: null,
      title: "",
      date: "",
      time: "",
      description: "",
      customerJid: null,
      customerDisplay: "",
    },
    // CALENDAR STATE
    calendarMonth: new Date().getMonth(),
    calendarYear: new Date().getFullYear(),
    calendarDays: [],
    selectedDate: null, // State for selected date filter
    monthNames: [
      "Januari",
      "Februari",
      "Maret",
      "April",
      "Mei",
      "Juni",
      "Juli",
      "Agustus",
      "September",
      "Oktober",
      "November",
      "Desember",
    ],

    // SETTINGS STATE
    inventoryFile: null,
    knowledgeFiles: [],
    inventoryUrl: "",
    scriptUrl: "",
    inventorySource: "excel", // 'excel' or 'sheet'
    // INVOICE STATE
    invoiceTitle: "INVOICE",
    invoiceAddress: "",
    invoiceFooter: "",
    invoiceLogo: null,
    invoiceLogoFile: null,
    invoiceLogoPreview: null,

    // SUBSCRIPTION STATE
    userRole: localStorage.getItem("user_role") || "USER",
    userExpiry: localStorage.getItem("user_expiry") || null,
    hideCountdown: localStorage.getItem("hide_countdown") === "true",
    remainingDays: 0,
    subscriptionStatus: "ACTIVE",
    isSubscriptionExpired: false, // For blocking modal

    // SCHEDULED BROADCAST STATE
    scheduledBroadcasts: [],
    showBroadcastScheduleModal: false,
    broadcastScheduleForm: {
      id: null,
      title: "",
      message: "",
      targetLabel: "all",
      manualNumbers: "",
      scheduledDate: "",
      scheduledTime: "",
    },
    broadcastTab: "scheduled", // 'scheduled' or 'history'

    init() {
      this.socket = io();

      // Initialize label distribution with zeros
      this.calculateLabelDistribution();

      // Cek Login
      if (!this.sessionId) {
        window.location.href = "/login.html";
        return;
      }

      // Check & fetch subscription status
      this.fetchSubscriptionStatus();

      // Restore data dari localStorage jika ada
      const savedStats = localStorage.getItem(`stats_${this.sessionId}`);
      if (savedStats) {
        try {
          this.stats = JSON.parse(savedStats);
        } catch (e) {}
      }

      if (this.sessionId) {
        this.connectSocket();
        this.fetchCRM();
        this.fetchSchedules();
        this.fetchSettings();
      }
      this.socket.on("message", (d) => this.handleIncomingMessage(d));
      this.socket.on("qr", (qr) => this.renderQR(qr));
      this.socket.on("stats_update", (newStats) => {
        // Only update if NOT filtering by month (Realtime View)
        if (!this.selectedMonth) {
          this.stats = newStats;
          this.updateChart(newStats);
        }
      });
      this.socket.on("ai_status", (status) => {
        this.aiActive = status.isActive;
        this.aiHasFile = status.hasFile;
        if (status.systemPrompt) this.aiPrompt = status.systemPrompt;
        if (status.inventoryFile) this.inventoryFile = status.inventoryFile;
        if (status.inventoryUrl) this.inventoryUrl = status.inventoryUrl;
        if (status.inventorySource)
          this.inventorySource = status.inventorySource;
        if (status.knowledgeFiles)
          this.knowledgeFiles = status.knowledgeFiles.map((f) => f.filename);
      });
      this.socket.on("ready", () => {
        this.isLoggedIn = true;
        this.qrCodeVal = null;
        this.isLoading = false;
        localStorage.setItem("wa_session_id", this.sessionId);
        this.fetchCRM();
        this.fetchChatHistory();
        // Fetch analytics immediately saat connect
        this.fetchAnalytics();
      });
      this.$watch("currentPage", (val) => {
        if (val === "analytics") {
          this.$nextTick(() => {
            this.initChart();
            this.fetchAnalytics();
          });
          this.analyticsInterval = setInterval(
            () => this.fetchAnalytics(),
            3000
          );
        } else {
          if (this.analyticsInterval) clearInterval(this.analyticsInterval);
        }
      });
      this.$watch("activeChat", (val) => {
        if (val && this.crmData[val]) {
          this.tempLabel = this.crmData[val].label || "General";
          this.tempNote = this.crmData[val].note || "";
        } else {
          this.tempLabel = "General";
          this.tempNote = "";
        }
      });
    },

    switchPage(page) {
      this.currentPage = page;
      this.mobileMenu = false;
      if (page === "schedule") {
        this.fetchSchedules();
        this.fetchScheduledBroadcasts();
      }
    },

    async fetchAnalytics() {
      if (!this.sessionId) {
        console.log("[fetchAnalytics] No sessionId");
        return;
      }
      try {
        console.log(
          `[fetchAnalytics] Fetching for sessionId: ${this.sessionId}`
        );

        const encodedSessionId = encodeURIComponent(this.sessionId);
        let query = "";
        if (this.selectedMonth) {
          query = `?month=${this.selectedMonth}`;
        }

        // Fetch Stats
        const res = await fetch(`/api/analytics/${encodedSessionId}${query}`);
        const json = await res.json();
        if (json.status === "success") {
          this.stats = json.data;
          this.topQuestions = json.data.topQuestions || [];
          this.updateChart(json.data);
          if (!this.selectedMonth) {
            localStorage.setItem(
              `stats_${this.sessionId}`,
              JSON.stringify(json.data)
            );
          }
        }

        // Fetch Top Products
        const resTop = await fetch(
          `/api/top-products/${encodedSessionId}${query}`
        );
        const jsonTop = await resTop.json();
        console.log("[fetchAnalytics] Top Products:", jsonTop);
        if (jsonTop.status === "success") {
          this.topProducts = jsonTop.data;
        }

        // Fetch Top Customers
        const resCust = await fetch(
          `/api/top-customers/${encodedSessionId}${query}`
        );
        const jsonCust = await resCust.json();
        this.topCustomers = jsonCust;
      } catch (e) {
        console.error("[fetchAnalytics] Error:", e);
      }
    },

    // --- CRM LOGIC ---
    async fetchCRM() {
      if (!this.sessionId) return;
      try {
        const res = await fetch(`/api/crm/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          this.crmData = json.data;
          this.calculateLabelDistribution();
        }
      } catch (e) {}
    },
    calculateLabelDistribution() {
      const counts = {};
      const labelMap = {
        Lead: "Lead (Calon)",
        Hot: "Hot Prospect 🔥",
        Pending: "Pending Payment ⏳",
        Lunas: "Lunas ✅",
        VIP: "VIP 🌟",
        Complain: "Complain ⚠️",
        General: "General",
      };

      // Initialize known labels
      Object.keys(labelMap).forEach((l) => (counts[l] = 0));

      Object.values(this.crmData).forEach((item) => {
        const label = item.label || "General";
        if (counts[label] !== undefined) {
          counts[label]++;
        } else {
          counts[label] = (counts[label] || 0) + 1;
        }
      });

      this.labelDistribution = Object.entries(counts)
        .map(([name, count]) => ({
          name,
          displayName: labelMap[name] || name,
          count,
        }))
        .sort((a, b) => b.count - a.count);
    },
    getCRMLabel(jid) {
      return this.crmData[jid] && this.crmData[jid].label
        ? this.crmData[jid].label
        : "General";
    },
    getCRMNote(jid) {
      return this.crmData[jid] && this.crmData[jid].note
        ? this.crmData[jid].note
        : "";
    },
    getLabelColor(label) {
      const colors = {
        Lead: "bg-blue-100 text-blue-700",
        Hot: "bg-orange-100 text-orange-700",
        Pending: "bg-yellow-100 text-yellow-700",
        Lunas: "bg-green-100 text-green-700",
        VIP: "bg-purple-100 text-purple-700",
        Complain: "bg-red-100 text-red-700",
        General: "bg-gray-100 text-gray-600",
      };
      return colors[label] || colors["General"];
    },
    async saveCRM() {
      if (!this.activeChat) return;
      const payload = {
        sessionId: this.sessionId,
        jid: this.activeChat,
        label: this.tempLabel,
        note: this.tempNote,
      };

      try {
        await fetch("/api/crm/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        // Update Local State
        this.crmData[this.activeChat] = {
          label: this.tempLabel,
          note: this.tempNote,
        };
        this.calculateLabelDistribution(); // Recalculate
        this.showCRMModal = false;
      } catch (e) {
        console.error("Failed to save CRM", e);
      }
    },

    async sendBroadcast() {
      if (!confirm("Yakin ingin mengirim broadcast?")) return;
      const payload = {
        sessionId: this.sessionId,
        targetLabel: this.broadcastTarget,
        manualNumbers: this.manualNumbers,
        message: this.broadcastMsg,
      };
      try {
        const res = await fetch("/chat/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        alert(json.message);
        this.showBroadcastModal = false;
        this.broadcastMsg = "";
      } catch (e) {
        alert("Gagal mengirim broadcast");
      }
    },

    // --- CHART UPDATE: BAR CHART PERBANDINGAN ---
    initChart() {
      const ctx = document.getElementById("messageChart");
      if (ctx) {
        if (chartInstance) chartInstance.destroy();
        chartInstance = new Chart(ctx.getContext("2d"), {
          type: "bar",
          data: {
            labels: ["Customer Baru", "Terbit Invoice", "Lunas"],
            datasets: [
              {
                label: "Total Aktivitas",
                data: [0, 0, 0],
                backgroundColor: ["#a5b4fc", "#6366f1", "#ec4899"],
                borderRadius: 8,
                barThickness: 40,
                borderWidth: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: {
                beginAtZero: true,
                grid: { color: "rgba(0,0,0,0.05)" },
              },
              x: {
                grid: { display: false },
              },
            },
            plugins: { legend: { display: false } },
          },
        });
      }

      // Hourly Chart
      const ctxHourly = document.getElementById("hourlyChart");
      if (ctxHourly) {
        if (hourlyChartInstance) hourlyChartInstance.destroy();
        hourlyChartInstance = new Chart(ctxHourly.getContext("2d"), {
          type: "line",
          data: {
            labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
            datasets: [
              {
                label: "Chat Masuk",
                data: Array(24).fill(0),
                fill: true,
                tension: 0.4,
                borderColor: "#ec4899",
                pointBackgroundColor: "#fff",
                pointBorderColor: "#ec4899",
                pointBorderWidth: 2,
                backgroundColor: (context) => {
                  const ctx = context.chart.ctx;
                  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
                  gradient.addColorStop(0, "rgba(236, 72, 153, 0.4)");
                  gradient.addColorStop(1, "rgba(236, 72, 153, 0.0)");
                  return gradient;
                },
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: {
                beginAtZero: true,
                ticks: { stepSize: 1 },
                grid: { color: "rgba(0,0,0,0.05)" },
              },
              x: { grid: { display: false } },
            },
            plugins: { legend: { display: false } },
          },
        });
      }
    },
    updateChart(data) {
      if (chartInstance) {
        chartInstance.data.datasets[0].data = [
          data.newCustomers || 0,
          data.invoiceIssued || 0,
          data.invoicePaid || 0,
        ];
        chartInstance.update();
      }
      if (hourlyChartInstance && data.hourlyActivity) {
        hourlyChartInstance.data.datasets[0].data = data.hourlyActivity;
        hourlyChartInstance.update();
      }
    },

    async exportDashboard() {
      if (!this.sessionId) return;
      window.open(`/api/export-dashboard/${this.sessionId}`, "_blank");
    },

    async openInvoiceModal() {
      if (!this.activeChat) return alert("Pilih chat customer dulu!");
      this.cart = [];
      this.invoiceNote = `INV/${new Date().getTime().toString().slice(-6)}`;
      this.qtyInput = 1;
      this.selectedProductIndex = "";
      this.isPaid = false;
      try {
        const res = await fetch(`/api/products/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          this.products = json.data;
          if (this.products.length === 0) {
            alert(
              "Belum ada data produk! Silakan upload Excel Produk di panel kiri atas."
            );
            return;
          }
          this.showInvoiceModal = true;
        }
      } catch (e) {
        alert("Gagal load produk");
      }
    },
    getDisplayName(prod) {
      const keys = Object.keys(prod);
      const nameKey = keys.find((k) =>
        /nama|name|produk|item|barang|product/i.test(k)
      );
      const priceKey = keys.find((k) =>
        /harga|price|rp|jual|cost|nilai/i.test(k)
      );

      const cleanPrice = (val) => {
        if (typeof val === "number") return val;
        if (typeof val === "string")
          return parseInt(val.replace(/\D/g, "")) || 0;
        return 0;
      };

      if (nameKey && priceKey)
        return `${prod[nameKey]} - ${this.formatRupiah(
          cleanPrice(prod[priceKey])
        )}`;

      // Fallback: Try to find any string and any number
      const stringVal = Object.values(prod).find(
        (v) => typeof v === "string" && v.length > 2
      );
      const numberVal = Object.values(prod).find((v) => typeof v === "number");

      if (stringVal && numberVal)
        return `${stringVal} - ${this.formatRupiah(numberVal)}`;

      return Object.values(prod).join(" - ");
    },
    addToCart() {
      if (this.selectedProductIndex === "") return;
      const prod = this.products[this.selectedProductIndex];
      const keys = Object.keys(prod);
      const nameKey = keys.find((k) =>
        /nama|name|produk|item|barang|product/i.test(k)
      );
      const priceKey = keys.find((k) =>
        /harga|price|rp|jual|cost|nilai/i.test(k)
      );

      let name = "Unknown Product";
      let price = 0;

      if (nameKey) name = prod[nameKey];
      else {
        const stringVal = Object.values(prod).find(
          (v) => typeof v === "string" && v.length > 2
        );
        if (stringVal) name = stringVal;
      }

      if (priceKey) price = prod[priceKey];
      else {
        const numberVal = Object.values(prod).find(
          (v) => typeof v === "number"
        );
        if (numberVal) price = numberVal;
      }

      // Clean price if it's a string
      if (typeof price === "string") {
        price = parseInt(String(price).replace(/\D/g, "")) || 0;
      }

      const qty = parseInt(this.qtyInput);
      this.cart.push({ name, price, qty, subtotal: price * qty });
      this.qtyInput = 1;
      this.selectedProductIndex = "";
    },
    removeFromCart(idx) {
      this.cart.splice(idx, 1);
    },
    get cartTotal() {
      let total = this.cart.reduce((s, i) => s + i.subtotal, 0);
      if (
        this.selectedShippingIndex !== "" &&
        this.shippingOptions[this.selectedShippingIndex]
      ) {
        total +=
          Number(this.shippingOptions[this.selectedShippingIndex].price) || 0;
      }
      return total;
    },
    formatRupiah(n) {
      return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        minimumFractionDigits: 0,
      }).format(n);
    },

    addShippingOption() {
      this.shippingOptions.push({ label: "", price: 0 });
    },
    removeShippingOption(idx) {
      this.shippingOptions.splice(idx, 1);
    },

    async sendInvoice() {
      if (this.cart.length === 0) return;

      let shippingData = null;
      if (
        this.selectedShippingIndex !== "" &&
        this.shippingOptions[this.selectedShippingIndex]
      ) {
        shippingData = {
          label: this.shippingOptions[this.selectedShippingIndex].label,
          cost:
            Number(this.shippingOptions[this.selectedShippingIndex].price) || 0,
        };
      }

      const payload = {
        sessionId: this.sessionId,
        to: this.activeChat,
        invoiceData: {
          invoiceNote: this.invoiceNote,
          customerName: this.getActiveChatObj()?.name || "Customer",
          cart: this.cart,
          total: this.cartTotal, // This now includes shipping
          isPaid: this.isPaid,
          shipping: shippingData,
        },
      };
      const btn = document.getElementById("btn-send-invoice");
      const originalText = btn.innerText;
      btn.innerText = "Memproses...";
      btn.disabled = true;
      try {
        const res = await fetch("/chat/send-invoice-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.status === "success") {
          this.showInvoiceModal = false;
          this.cart = [];
          alert("Invoice PDF berhasil dikirim! 📄");
          // Refresh Analytics & Top Products
          this.fetchAnalytics();
        } else {
          alert("Gagal mengirim invoice.");
        }
      } catch (e) {
        alert("Terjadi kesalahan sistem.");
      } finally {
        btn.innerText = originalText;
        btn.disabled = false;
      }
    },

    async fetchUnpaidInvoices() {
      try {
        const res = await fetch(`/invoice/list/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          this.unpaidInvoices = json.data;
        }
      } catch (e) {
        console.error("Failed to fetch unpaid invoices", e);
      }
    },

    async markAsPaid(invoiceId) {
      const inv = this.unpaidInvoices.find((i) => i.id === invoiceId);
      if (!inv) return;

      if (
        !confirm(`Tandai invoice ${inv.invoiceNote || inv.id} sebagai LUNAS?`)
      )
        return;

      const payload = {
        sessionId: this.sessionId,
        to: inv.to,
        invoiceId: invoiceId,
        action: "pay",
        invoiceData: {},
      };

      try {
        const res = await fetch("/chat/send-invoice-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.status === "success") {
          alert("Invoice berhasil dilunaskan dan dikirim! 📄");
          this.fetchUnpaidInvoices();
        } else {
          alert("Gagal memproses invoice.");
        }
      } catch (e) {
        alert("Error processing invoice.");
      }
    },

    async sendInvoiceReminder(invoiceId) {
      const inv = this.unpaidInvoices.find((i) => i.id === invoiceId);
      if (!inv) return;
      if (
        !confirm(`Kirim reminder untuk invoice ${inv.invoiceNote || inv.id}?`)
      )
        return;

      try {
        const res = await fetch("/chat/send-invoice-reminder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: this.sessionId, invoiceId }),
        });
        const json = await res.json();
        if (json.status === "success") alert("Reminder terkirim! 🔔");
        else alert("Gagal mengirim reminder.");
      } catch (e) {
        alert("Error sending reminder.");
      }
    },

    async fetchSettings() {
      try {
        // Fetch Templates
        fetch(`/templates/list/${this.sessionId}`)
          .then((r) => r.json())
          .then((d) => {
            if (d.status === "success") this.messageTemplates = d.data;
          });

        const res = await fetch(`/ai/settings/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          if (json.data.systemPrompt) this.aiPrompt = json.data.systemPrompt;
          this.inventoryFile = json.data.inventoryFile;
          this.inventoryUrl = json.data.inventoryUrl || "";
          this.inventorySource = json.data.inventorySource || "excel";
          this.knowledgeFiles = json.data.knowledgeFiles || [];

          if (json.data.invoiceSettings) {
            this.invoiceTitle = json.data.invoiceSettings.title || "INVOICE";
            this.invoiceAddress = json.data.invoiceSettings.address || "";
            this.invoiceFooter = json.data.invoiceSettings.footer || "";
            this.invoiceLogo = json.data.invoiceSettings.logo || null;
            this.shippingOptions =
              json.data.invoiceSettings.shippingOptions || [];
          }
        }
      } catch (e) {
        console.error("Failed to fetch settings", e);
      }
    },

    addTemplate() {
      this.messageTemplates.push({ shortcut: "", content: "" });
    },
    removeTemplate(idx) {
      this.messageTemplates.splice(idx, 1);
    },
    async saveTemplates() {
      try {
        const res = await fetch("/templates/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: this.sessionId,
            templates: this.messageTemplates,
          }),
        });
        const json = await res.json();
        if (json.status === "success") alert("Template tersimpan!");
        else alert("Gagal menyimpan template");
      } catch (e) {
        alert("Error saving templates");
      }
    },

    async setInventorySource(source) {
      try {
        const res = await fetch("/ai/set-inventory-source", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: this.sessionId, source }),
        });
        const json = await res.json();
        if (json.status === "success") {
          this.inventorySource = source;
          // alert(`Sumber data diubah ke: ${source === 'excel' ? 'Excel Master' : 'Google Sheet'}`);
        }
      } catch (e) {
        console.error(e);
      }
    },

    handleLogoUpload(e) {
      if (e.target.files.length > 0) {
        this.invoiceLogoFile = e.target.files[0];
        // Preview
        const reader = new FileReader();
        reader.onload = (e) => {
          this.invoiceLogoPreview = e.target.result;
        };
        reader.readAsDataURL(this.invoiceLogoFile);
      }
    },

    async saveInvoiceSettings() {
      const fd = new FormData();
      fd.append("sessionId", this.sessionId);
      fd.append("title", this.invoiceTitle);
      fd.append("address", this.invoiceAddress);
      fd.append("footer", this.invoiceFooter);
      fd.append("shippingOptions", JSON.stringify(this.shippingOptions));
      if (this.invoiceLogoFile) {
        fd.append("logo", this.invoiceLogoFile);
      }

      try {
        const res = await fetch("/invoice/settings", {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        if (json.status === "success") {
          alert("Pengaturan Invoice Disimpan!");
          this.invoiceLogo = json.data.logo;
          this.invoiceLogoFile = null;
        } else {
          alert("Gagal menyimpan settings");
        }
      } catch (e) {
        console.error(e);
        alert("Error saving invoice settings");
      }
    },

    async saveInventoryUrl() {
      if (!this.inventoryUrl) return alert("Masukkan URL Google Sheet CSV!");
      try {
        const res = await fetch("/ai/save-inventory-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: this.sessionId,
            inventoryUrl: this.inventoryUrl,
          }),
        });
        const json = await res.json();
        if (json.success) alert("URL Tersimpan!");
        else alert("Gagal menyimpan URL");
      } catch (e) {
        console.error(e);
        alert("Error saving URL");
      }
    },

    async syncInventory() {
      if (!this.inventoryUrl) return alert("Simpan URL terlebih dahulu!");
      try {
        const res = await fetch("/ai/sync-inventory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: this.sessionId }),
        });
        const json = await res.json();
        if (json.success)
          alert(`Sync Berhasil! ${json.count} produk terupdate.`);
        else alert("Gagal Sync: " + json.error);
      } catch (e) {
        console.error(e);
        alert("Error syncing inventory");
      }
    },

    uploadInventory(e) {
      if (e.target.files.length === 0) return;
      const fd = new FormData();
      fd.append("sessionId", this.sessionId);
      fd.append("file", e.target.files[0]);

      // Reset input value so same file can be selected again
      const fileInput = e.target;

      fetch("/ai/upload-inventory", { method: "POST", body: fd })
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "success") {
            alert("Inventory Master Berhasil Diupload!");
            this.inventoryFile = d.filename;
          } else {
            alert("Gagal Upload Inventory");
          }
          fileInput.value = "";
        });
    },

    uploadKnowledge(e) {
      if (e.target.files.length === 0) return;
      const fd = new FormData();
      fd.append("sessionId", this.sessionId);
      fd.append("file", e.target.files[0]);

      const fileInput = e.target;

      fetch("/ai/upload-knowledge", { method: "POST", body: fd })
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "success") {
            alert("Knowledge Base Berhasil Ditambahkan!");
            if (!this.knowledgeFiles.includes(d.filename)) {
              this.knowledgeFiles.push(d.filename);
            }
          } else {
            alert("Gagal Upload Knowledge Base");
          }
          fileInput.value = "";
        });
    },

    deleteKnowledge(filename) {
      if (!confirm(`Hapus file "${filename}" dari knowledge base?`)) return;
      fetch(`/ai/knowledge/${this.sessionId}/${filename}`, { method: "DELETE" })
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "success") {
            this.knowledgeFiles = this.knowledgeFiles.filter(
              (f) => f !== filename
            );
          } else {
            alert("Gagal menghapus file");
          }
        });
    },

    // Legacy support (redirect to inventory)
    uploadExcel(e) {
      this.uploadInventory(e);
    },

    toggleAI() {
      fetch("/ai/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId,
          isActive: this.aiActive,
        }),
      });
    },
    savePrompt() {
      fetch("/ai/save-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId,
          prompt: this.aiPrompt,
        }),
      }).then(() => {
        alert("Prompt disimpan!");
        this.showPromptModal = false;
      });
    },
    toggleGroupSettings() {
      localStorage.setItem("wa_show_groups", this.showGroups);
      if (
        !this.showGroups &&
        this.activeChat &&
        this.activeChat.includes("@g.us")
      ) {
        this.activeChat = null;
      }
    },
    startAuth() {
      if (!this.sessionId) return;
      this.isLoading = true;
      this.connectSocket();
      fetch("/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "connected") {
            this.isLoggedIn = true;
            this.isLoading = false;
            localStorage.setItem("wa_session_id", this.sessionId);
            this.fetchCRM();
            this.fetchChatHistory();
          }
        });
    },
    connectSocket() {
      this.socket.emit("join_session", this.sessionId);
      fetch(`/session/status/${this.sessionId}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.status === "connected") {
            this.isLoggedIn = true;
            this.isLoading = false;
            this.fetchCRM();
            this.fetchChatHistory();
          }
        });
    },
    renderQR(qr) {
      this.qrCodeVal = qr;
      this.isLoading = false;
      const c = document.getElementById("qrcode-container");
      c.innerHTML = "";
      new QRCode(c, { text: qr, width: 200, height: 200 });
    },
    logout() {
      if (!confirm("Logout?")) return;
      fetch("/session/stop", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId }),
      });
      localStorage.removeItem("wa_session_id");
      location.reload();
    },
    handleFileSelect(e) {
      if (e.target.files.length > 0) this.selectedFile = e.target.files[0];
    },
    async sendMessage() {
      if (!this.inputText.trim() && !this.selectedFile) return;
      let text = this.inputText;
      const to = this.activeChat;
      const isMedia = !!this.selectedFile;

      // --- TEMPLATE EXPANSION ---
      if (!isMedia && text.startsWith("/")) {
        const tpl = this.messageTemplates.find(
          (t) => t.shortcut === text.trim()
        );
        if (tpl) {
          text = tpl.content;
        }
      }
      // --------------------------

      // Optimistic UI: Tampilkan pesan sementara
      if (!isMedia) {
        const tempId = "temp-" + Date.now();
        if (!this.messages[to]) this.messages[to] = [];
        this.messages[to].push({
          id: tempId,
          from: to,
          text: text,
          fromMe: true,
          timestamp: new Date(),
          senderName: "Me",
          mediaUrl: null,
        });
        this.scrollToBottom();
      }

      this.inputText = "";
      try {
        if (isMedia) {
          const fd = new FormData();
          fd.append("sessionId", this.sessionId);
          fd.append("to", to);
          fd.append("caption", text);
          fd.append("file", this.selectedFile);
          await fetch("/chat/send-media", { method: "POST", body: fd });
          this.selectedFile = null;
        } else {
          const res = await fetch("/chat/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: this.sessionId,
              to: to,
              text: text,
            }),
          });
          const data = await res.json();
          if (data.error) {
            alert("Gagal kirim: " + data.error);
            // Remove temp message if failed? (Optional)
          }
        }
      } catch (e) {
        console.error(e);
        alert("Gagal kirim (Network Error)");
      }
    },
    handleIncomingMessage(data) {
      const chatId = data.from;
      if (!this.crmData[chatId]) {
        this.crmData[chatId] = { label: "General", note: "" };
      }
      if (!this.messages[chatId]) this.messages[chatId] = [];
      if (this.messages[chatId].some((m) => m.id === data.id)) return;

      // FIX: Deduplikasi pesan manual (Optimistic UI vs Real Socket Data)
      let isReplacement = false;
      if (data.fromMe) {
        // Cari pesan sementara yang teksnya sama
        const tempIdx = this.messages[chatId].findIndex(
          (m) => m.id.toString().startsWith("temp-") && m.text === data.text
        );
        if (tempIdx !== -1) {
          // Replace pesan sementara dengan data asli dari server
          this.messages[chatId][tempIdx] = data;
          isReplacement = true;
        }
      }

      if (!isReplacement) {
        this.messages[chatId].push(data);
      }

      const existingChat = this.chatList.find((c) => c.id === chatId);
      if (existingChat) {
        existingChat.lastMsg =
          data.text || (data.mediaType ? `[${data.mediaType}]` : "Media");
        existingChat.timestamp = new Date();
        if (data.chatName) existingChat.name = data.chatName;
        if (data.chatProfilePicUrl)
          existingChat.profilePicUrl = data.chatProfilePicUrl;
        if (this.activeChat !== chatId) existingChat.unread++;
        this.chatList = this.chatList.sort((a, b) => b.timestamp - a.timestamp);
      } else {
        this.chatList.unshift({
          id: chatId,
          name: data.chatName || this.formatLabel(chatId),
          profilePicUrl: data.chatProfilePicUrl,
          lastMsg:
            data.text || (data.mediaType ? `[${data.mediaType}]` : "Media"),
          timestamp: new Date(),
          unread: this.activeChat === chatId ? 0 : 1,
          isGroup: data.isGroup,
        });
      }
      if (this.activeChat === chatId) this.scrollToBottom();
    },
    getActiveChatObj() {
      return this.chatList.find((c) => c.id === this.activeChat);
    },
    getInitials(name) {
      if (!name) return "?";
      let cleanName = name.toString().replace(/@.*/, "").replace(/\+/g, "");
      let parts = cleanName.split(" ").filter((p) => p.length > 0);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return cleanName.substring(0, 2).toUpperCase();
    },
    formatLabel(jid) {
      if (!jid) return "";
      let clean = jid.replace("@s.whatsapp.net", "").replace("@g.us", "");
      if (jid.includes("@g.us")) return "Grup " + clean.substring(0, 6);
      if (clean.startsWith("62")) return "+" + clean.slice(2);
      return clean;
    },
    selectChat(chat) {
      this.activeChat = chat.id;
      chat.unread = 0;
      this.mobileMenu = false;
      this.scrollToBottom();
      if (!this.messages[chat.id]) this.messages[chat.id] = [];
    },
    get activeMessages() {
      return this.messages[this.activeChat];
    },
    get totalUnread() {
      return this.chatList.reduce((acc, c) => acc + (c.unread || 0), 0);
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const c = document.getElementById("chat-container");
        if (c) c.scrollTop = c.scrollHeight;
      });
    },
    formatTime(date) {
      return new Date(date).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    async fetchChatHistory() {
      try {
        const res = await fetch(`/chat/history/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          json.data.forEach((chat) => {
            const existing = this.chatList.find((c) => c.id === chat.remoteJid);
            if (!existing) {
              this.chatList.push({
                id: chat.remoteJid,
                name: chat.name || chat.remoteJid,
                unread: 0,
                lastMsg:
                  chat.messages.length > 0
                    ? chat.messages[chat.messages.length - 1].text
                    : "",
                lastTime: chat.updatedAt,
                isGroup: chat.remoteJid.endsWith("@g.us"),
                profilePicUrl: null,
              });
            }

            if (!this.messages[chat.remoteJid])
              this.messages[chat.remoteJid] = [];

            // Avoid duplicates if already loaded via socket
            const currentIds = new Set(
              this.messages[chat.remoteJid].map((m) => m.id)
            );

            chat.messages.forEach((m) => {
              if (!currentIds.has(m.id)) {
                this.messages[chat.remoteJid].push({
                  id: m.id,
                  text: m.text,
                  time: m.createdAt,
                  fromMe: m.fromMe,
                  mediaUrl: m.mediaUrl,
                });
              }
            });

            this.messages[chat.remoteJid].sort(
              (a, b) => new Date(a.time) - new Date(b.time)
            );
          });
          this.chatList.sort(
            (a, b) => new Date(b.lastTime) - new Date(a.lastTime)
          );
        }
      } catch (e) {
        console.error("Failed to load history", e);
      }
    },
    async deleteMessage(id) {
      if (!confirm("Hapus pesan ini?")) return;
      try {
        await fetch(`/chat/message/${id}`, { method: "DELETE" });
        const chatMessages = this.messages[this.activeChat];
        const idx = chatMessages.findIndex((m) => m.id === id);
        if (idx !== -1) chatMessages.splice(idx, 1);
      } catch (e) {
        alert("Gagal menghapus pesan");
      }
    },
    async deleteChat(chatId) {
      if (!confirm("Hapus chat ini beserta semua pesannya?")) return;
      try {
        const res = await fetch(`/chat/delete/${this.sessionId}/${chatId}`, {
          method: "DELETE",
        });
        const data = await res.json();
        if (data.status === "success") {
          this.chatList = this.chatList.filter((c) => c.id !== chatId);
          delete this.messages[chatId];
          if (this.activeChat === chatId) {
            this.activeChat = null;
          }
        } else {
          alert("Gagal menghapus chat");
        }
      } catch (e) {
        console.error(e);
        alert("Gagal menghapus chat");
      }
    },

    // --- SCHEDULE LOGIC ---
    async fetchSchedules() {
      if (!this.sessionId) return;
      try {
        const res = await fetch(`/schedule/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          this.schedules = json.data;
          this.generateCalendar(); // Refresh calendar when schedules load
        }
      } catch (e) {
        console.error("Failed to fetch schedules", e);
      }
    },

    // --- CALENDAR LOGIC ---
    generateCalendar() {
      const year = this.calendarYear;
      const month = this.calendarMonth;
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);
      const daysInMonth = lastDay.getDate();
      const startDay = firstDay.getDay();

      const days = [];
      for (let i = 0; i < startDay; i++) {
        days.push({
          date: "",
          fullDate: "",
          hasSchedule: false,
          hasBroadcast: false,
        });
      }

      for (let i = 1; i <= daysInMonth; i++) {
        // Format Date YYYY-MM-DD manually to avoid timezone shifts
        const m = String(month + 1).padStart(2, "0");
        const d = String(i).padStart(2, "0");
        const dateStr = `${year}-${m}-${d}`;

        const hasSchedule = this.schedules.some((s) =>
          s.date.startsWith(dateStr)
        );
        const hasBroadcast = this.scheduledBroadcasts.some(
          (b) => b.scheduledAt.startsWith(dateStr) && b.status === "PENDING"
        );

        days.push({
          date: i,
          fullDate: dateStr,
          hasSchedule,
          hasBroadcast,
        });
      }
      this.calendarDays = days;
    },
    changeMonth(offset) {
      this.calendarMonth += offset;
      if (this.calendarMonth > 11) {
        this.calendarMonth = 0;
        this.calendarYear++;
      } else if (this.calendarMonth < 0) {
        this.calendarMonth = 11;
        this.calendarYear--;
      }
      this.generateCalendar();
    },
    isToday(day) {
      if (!day.date) return false;
      const today = new Date();
      return (
        day.date === today.getDate() &&
        this.calendarMonth === today.getMonth() &&
        this.calendarYear === today.getFullYear()
      );
    },
    selectDate(day) {
      if (day.date) {
        this.selectedDate = day.fullDate;
      }
    },
    get filteredSchedules() {
      if (!this.selectedDate) {
        return this.schedules;
      }
      return this.schedules.filter((s) => s.date.startsWith(this.selectedDate));
    },
    get filteredBroadcasts() {
      if (!this.selectedDate) return [];
      return this.scheduledBroadcasts.filter((b) =>
        b.scheduledAt.startsWith(this.selectedDate)
      );
    },

    openScheduleModal(schedule = null) {
      if (schedule) {
        // Edit Mode
        const d = new Date(schedule.date);
        this.scheduleForm = {
          id: schedule.id,
          title: schedule.title,
          date: d.toISOString().split("T")[0],
          time: d.toTimeString().slice(0, 5),
          description: schedule.description || "",
          customerJid: schedule.customerJid,
        };
      } else {
        // Create Mode
        this.scheduleForm = {
          id: null,
          title: "",
          date: new Date().toISOString().split("T")[0],
          time: "09:00",
          description: "",
          customerJid: this.activeChat || null,
        };
      }

      // Calculate Display Name
      const jid = this.scheduleForm.customerJid;
      if (jid) {
        const chat = this.chatList.find((c) => c.id === jid);
        if (chat && chat.name) {
          this.scheduleForm.customerDisplay = chat.name;
        } else {
          this.scheduleForm.customerDisplay = jid.replace(
            "@s.whatsapp.net",
            ""
          );
        }
      } else {
        this.scheduleForm.customerDisplay = "";
      }

      this.showScheduleModal = true;
    },
    async saveSchedule() {
      const { id, title, date, time, description, customerJid } =
        this.scheduleForm;
      if (!title || !date || !time)
        return alert("Judul, Tanggal, dan Waktu wajib diisi!");

      const dateTime = new Date(`${date}T${time}`);
      const payload = {
        sessionId: this.sessionId,
        title,
        description,
        date: dateTime,
        customerJid,
      };

      try {
        let url = "/schedule/create";
        let method = "POST";
        if (id) {
          url = `/schedule/update/${id}`;
          method = "PUT";
        }

        const res = await fetch(url, {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();

        if (json.status === "success") {
          this.showScheduleModal = false;
          this.fetchSchedules();
          alert(id ? "Jadwal diperbarui!" : "Jadwal dibuat!");
        } else {
          alert("Gagal menyimpan jadwal");
        }
      } catch (e) {
        alert("Terjadi kesalahan");
      }
    },
    async deleteSchedule(id) {
      if (!confirm("Hapus jadwal ini?")) return;
      try {
        await fetch(`/schedule/delete/${id}`, { method: "DELETE" });
        this.fetchSchedules();
      } catch (e) {
        alert("Gagal menghapus jadwal");
      }
    },
    formatDateTime(dateStr) {
      const d = new Date(dateStr);
      return d.toLocaleString("id-ID", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    formatCustomerDisplay(jid) {
      if (!jid) return "-";
      const chat = this.chatList.find((c) => c.id === jid);
      if (chat && chat.name) {
        return chat.name;
      }
      return jid.replace("@s.whatsapp.net", "");
    },

    // ====== SCHEDULED BROADCAST FUNCTIONS ======
    async fetchScheduledBroadcasts() {
      if (!this.sessionId) return;
      try {
        const res = await fetch(`/api/broadcasts/${this.sessionId}`);
        const json = await res.json();
        if (json.status === "success") {
          this.scheduledBroadcasts = json.data;
        }
      } catch (e) {
        console.error("Failed to fetch broadcasts", e);
      }
    },

    openBroadcastScheduleModal(broadcast = null) {
      if (broadcast) {
        // Edit mode
        const d = new Date(broadcast.scheduledAt);
        this.broadcastScheduleForm = {
          id: broadcast.id,
          title: broadcast.title,
          message: broadcast.message,
          targetLabel: broadcast.targetLabel,
          manualNumbers: broadcast.manualNumbers || "",
          scheduledDate: d.toISOString().split("T")[0],
          scheduledTime: d.toTimeString().slice(0, 5),
          sendNow: "schedule",
        };
      } else {
        // Create mode
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        this.broadcastScheduleForm = {
          id: null,
          title: "",
          message: "",
          targetLabel: "all",
          manualNumbers: "",
          scheduledDate: tomorrow.toISOString().split("T")[0],
          scheduledTime: "09:00",
          sendNow: "schedule",
        };
      }
      this.showBroadcastScheduleModal = true;
    },

    async saveBroadcastSchedule() {
      const {
        id,
        title,
        message,
        targetLabel,
        manualNumbers,
        scheduledDate,
        scheduledTime,
      } = this.broadcastScheduleForm;

      if (!title || !message || !scheduledDate || !scheduledTime) {
        return alert("Judul, Pesan, Tanggal, dan Waktu wajib diisi!");
      }

      const scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`);
      if (scheduledAt <= new Date()) {
        return alert("Waktu broadcast harus di masa depan!");
      }

      const payload = {
        sessionId: this.sessionId,
        title,
        message,
        targetLabel,
        manualNumbers: manualNumbers || null,
        scheduledAt,
      };

      try {
        let url = "/api/broadcasts";
        let method = "POST";
        if (id) {
          url = `/api/broadcasts/${id}`;
          method = "PUT";
        }

        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();

        if (json.status === "success") {
          this.showBroadcastScheduleModal = false;
          this.fetchScheduledBroadcasts();
          alert(id ? "Broadcast diperbarui!" : "Broadcast dijadwalkan!");
        } else {
          alert(json.error || "Gagal menyimpan broadcast");
        }
      } catch (e) {
        alert("Terjadi kesalahan");
      }
    },

    async sendBroadcastNow() {
      const { title, message, targetLabel, manualNumbers } =
        this.broadcastScheduleForm;

      if (!title || !message) {
        return alert("Judul dan Pesan wajib diisi!");
      }

      // Gunakan waktu sekarang + 2 detik agar langsung diproses oleh processor
      const now = new Date();
      now.setSeconds(now.getSeconds() + 2);

      const payload = {
        sessionId: this.sessionId,
        title,
        message,
        targetLabel,
        manualNumbers: manualNumbers || null,
        scheduledAt: now,
      };

      try {
        const res = await fetch("/api/broadcasts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json.status === "success") {
          this.showBroadcastScheduleModal = false;
          this.fetchScheduledBroadcasts();
          alert("Broadcast sedang diproses untuk dikirim sekarang!");
        } else {
          alert(json.error || "Gagal mengirim broadcast");
        }
      } catch (e) {
        console.error("Error sending broadcast now:", e);
        alert("Gagal mengirim broadcast");
      }
    },

    async cancelBroadcast(id) {
      if (!confirm("Batalkan broadcast ini?")) return;
      try {
        const res = await fetch(`/api/broadcasts/${id}/cancel`, {
          method: "POST",
        });
        const json = await res.json();
        if (json.status === "success") {
          this.fetchScheduledBroadcasts();
          alert("Broadcast dibatalkan");
        } else {
          alert(json.error || "Gagal membatalkan");
        }
      } catch (e) {
        alert("Gagal membatalkan broadcast");
      }
    },

    async deleteBroadcast(id) {
      if (!confirm("Hapus broadcast ini?")) return;
      try {
        await fetch(`/api/broadcasts/${id}`, { method: "DELETE" });
        this.fetchScheduledBroadcasts();
      } catch (e) {
        alert("Gagal menghapus broadcast");
      }
    },

    get pendingBroadcasts() {
      return this.scheduledBroadcasts.filter((b) => b.status === "PENDING");
    },

    get historyBroadcasts() {
      return this.scheduledBroadcasts.filter((b) => b.status !== "PENDING");
    },

    getBroadcastStatusColor(status) {
      const colors = {
        PENDING: "bg-yellow-100 text-yellow-700 border-yellow-200",
        SENT: "bg-green-100 text-green-700 border-green-200",
        FAILED: "bg-red-100 text-red-700 border-red-200",
        CANCELLED: "bg-gray-100 text-gray-600 border-gray-200",
      };
      return colors[status] || "bg-gray-100 text-gray-600 border-gray-200";
    },

    getBroadcastStatusIcon(status) {
      const icons = {
        PENDING: "⏳",
        SENT: "✅",
        FAILED: "❌",
        CANCELLED: "🚫",
      };
      return icons[status] || "❓";
    },

    getTargetLabelDisplay(label) {
      const labels = {
        all: "📱 Semua Kontak",
        Lead: "📋 Lead",
        Hot: "🔥 Hot",
        Pending: "⏳ Pending",
        Lunas: "✅ Lunas",
        VIP: "👑 VIP",
        Complain: "⚠️ Complain",
        General: "📌 General",
        manual: "✍️ Nomor Manual",
        label: "🏷️ Label CRM",
      };
      return labels[label] || label;
    },

    // ====== SUBSCRIPTION FUNCTIONS ======
    async fetchSubscriptionStatus() {
      if (!this.sessionId) return;

      try {
        const res = await fetch(
          `/api/user/subscription/${encodeURIComponent(this.sessionId)}`
        );
        const json = await res.json();

        if (json.status === "success") {
          const data = json.data;
          this.userRole = data.role;
          this.userExpiry = data.expiryDate;
          this.remainingDays = data.remainingDays || 0;
          this.subscriptionStatus = data.subscriptionStatus;
          this.hideCountdown = data.hideCountdown;

          // Update localStorage
          localStorage.setItem("user_role", data.role);
          localStorage.setItem("user_expiry", data.expiryDate || "");
          localStorage.setItem(
            "hide_countdown",
            data.hideCountdown?.toString() || "false"
          );

          // Check if expired - BLOCK THE PAGE
          if (data.isExpired && data.role === "USER") {
            this.isSubscriptionExpired = true;
          }
        }
      } catch (e) {
        console.error("Failed to fetch subscription status:", e);
        // Use cached data from localStorage
        this.calculateRemainingDays();

        // Also check localStorage for expired status
        if (
          this.userRole === "USER" &&
          this.remainingDays <= 0 &&
          this.userExpiry
        ) {
          this.isSubscriptionExpired = true;
        }
      }
    },

    calculateRemainingDays() {
      if (this.userRole === "DEVELOPER" || !this.userExpiry) {
        this.remainingDays = 999;
        return;
      }

      const now = new Date();
      const expiry = new Date(this.userExpiry);
      const diffTime = expiry - now;
      this.remainingDays = Math.max(
        0,
        Math.ceil(diffTime / (1000 * 60 * 60 * 24))
      );
    },

    async toggleCountdownVisibility() {
      this.hideCountdown = !this.hideCountdown;
      localStorage.setItem("hide_countdown", this.hideCountdown.toString());

      try {
        await fetch("/api/user/toggle-countdown", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: this.sessionId,
            hideCountdown: this.hideCountdown,
          }),
        });
      } catch (e) {
        console.error("Failed to save countdown preference:", e);
      }
    },

    formatExpiryDate() {
      if (!this.userExpiry) return "-";
      return new Date(this.userExpiry).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    },
  };
}
