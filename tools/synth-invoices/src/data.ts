/** Fictional vendors and a grocery catalogue (English + Hindi names) for synthetic invoices. */

export interface Vendor {
  name: string;
  /** 2-digit GST state code. 20 = Jharkhand (our stores). */
  state: string;
  city: string;
  address: string;
  /** Letter 4 of the PAN: C company, F firm, P proprietor. */
  entity: "C" | "F" | "P";
  phone: string;
}

export const VENDORS: Vendor[] = [
  { name: "Shree Ganesh Distributors", state: "20", city: "Ranchi", address: "12, Upper Bazar, Ranchi - 834001", entity: "F", phone: "0651-2210456" },
  { name: "Maa Tara Traders", state: "20", city: "Ranchi", address: "Shop 4, Daily Market, Main Road, Ranchi - 834001", entity: "P", phone: "94311 20457" },
  { name: "Jharkhand FMCG Agencies Pvt. Ltd.", state: "20", city: "Ranchi", address: "Plot 22, Industrial Area, Kokar, Ranchi - 834001", entity: "C", phone: "0651-2545120" },
  { name: "Laxmi Narayan Enterprises", state: "20", city: "Jamshedpur", address: "Sakchi Bazar, Jamshedpur - 831001", entity: "F", phone: "0657-2431187" },
  { name: "Bharat Wholesale Mart", state: "20", city: "Dhanbad", address: "Bank More, Dhanbad - 826001", entity: "F", phone: "0326-2302219" },
  { name: "Sai Krupa Oil & Foods", state: "20", city: "Hazaribagh", address: "Main Road, Hazaribagh - 825301", entity: "P", phone: "06546-264110" },
  { name: "Ganga Spices & Dry Fruits Pvt. Ltd.", state: "10", city: "Patna", address: "Marufganj, Patna City, Patna - 800008", entity: "C", phone: "0612-2643311" },
  { name: "Bengal Home Care Supplies", state: "19", city: "Kolkata", address: "45, Canning Street, Kolkata - 700001", entity: "F", phone: "033-22357788" },
  { name: "Utkal Rice Mills", state: "21", city: "Cuttack", address: "Link Road, Cuttack - 753012", entity: "C", phone: "0671-2333456" },
  { name: "Shiv Shakti Dairy", state: "20", city: "Ranchi", address: "Ratu Road, Ranchi - 834005", entity: "P", phone: "98350 44120" },
];

export interface Store {
  name: string;
  address: string;
}

/** Our buyer: one GSTIN (same state), six outlets. */
export const BUYER = {
  name: "Apna Rashan Supermarket",
  pan14: "20AAPFA4821K1Z",
  stores: [
    { name: "Apna Rashan - Lalpur", address: "Lalpur Chowk, Ranchi - 834001" },
    { name: "Apna Rashan - Harmu", address: "Harmu Housing Colony, Ranchi - 834002" },
    { name: "Apna Rashan - Bariatu", address: "Bariatu Road, Ranchi - 834009" },
    { name: "Apna Rashan - Kanke", address: "Kanke Road, Ranchi - 834008" },
    { name: "Apna Rashan - Doranda", address: "Doranda Market, Ranchi - 834002" },
    { name: "Apna Rashan - Morabadi", address: "Morabadi Ground Road, Ranchi - 834008" },
  ] as Store[],
};

export interface Item {
  en: string;
  hi: string;
  hsn: string;
  /** Current GST % (2025 slabs: 0, 5, 18, 40). */
  gst: number;
  /** Older slab (12 or 28) used on legacy invoices. */
  legacyGst?: number;
  unit: string;
  /** Rate per unit before tax, in rupees [min, max]. */
  rate: [number, number];
  mrp?: number;
  /** Typical order qty range. */
  qty: [number, number];
  /** Sold by weight (decimal qty). */
  loose?: boolean;
}

export const ITEMS: Item[] = [
  { en: "Tata Salt 1kg", hi: "टाटा नमक 1 कि.ग्रा.", hsn: "25010020", gst: 0, unit: "PKT", rate: [24, 27], mrp: 28, qty: [20, 100] },
  { en: "Aashirvaad Atta 10kg", hi: "आशीर्वाद आटा 10 कि.ग्रा.", hsn: "11010000", gst: 5, unit: "BAG", rate: [420, 455], mrp: 499, qty: [5, 30] },
  { en: "Sugar (Loose)", hi: "चीनी (खुली)", hsn: "17019990", gst: 5, unit: "KG", rate: [38, 44], qty: [25, 200], loose: true },
  { en: "Fortune Soyabean Oil 1L", hi: "फॉर्च्यून सोयाबीन तेल 1 ली.", hsn: "15079010", gst: 5, unit: "BTL", rate: [128, 142], mrp: 165, qty: [12, 60] },
  { en: "Dhara Mustard Oil 1L", hi: "धारा सरसों तेल 1 ली.", hsn: "15149120", gst: 5, unit: "BTL", rate: [150, 168], mrp: 190, qty: [12, 48] },
  { en: "India Gate Basmati Rice 5kg", hi: "इंडिया गेट बासमती चावल 5 कि.ग्रा.", hsn: "10063020", gst: 5, unit: "BAG", rate: [520, 610], mrp: 699, qty: [4, 20] },
  { en: "Arhar Dal (Loose)", hi: "अरहर दाल (खुली)", hsn: "07136000", gst: 0, unit: "KG", rate: [118, 145], qty: [10, 100], loose: true },
  { en: "Masoor Dal (Loose)", hi: "मसूर दाल (खुली)", hsn: "07134000", gst: 0, unit: "KG", rate: [82, 98], qty: [10, 60], loose: true },
  { en: "Tata Tea Premium 500g", hi: "टाटा चाय प्रीमियम 500 ग्रा.", hsn: "09024020", gst: 5, unit: "PKT", rate: [235, 262], mrp: 290, qty: [6, 36] },
  { en: "Everest Turmeric Powder 200g", hi: "एवरेस्ट हल्दी पाउडर 200 ग्रा.", hsn: "09103030", gst: 5, unit: "PKT", rate: [52, 60], mrp: 68, qty: [10, 50] },
  { en: "MDH Garam Masala 100g", hi: "एमडीएच गरम मसाला 100 ग्रा.", hsn: "09109100", gst: 5, unit: "PKT", rate: [74, 84], mrp: 95, qty: [10, 40] },
  { en: "Parle-G Biscuit 800g", hi: "पारले-जी बिस्कुट 800 ग्रा.", hsn: "19053100", gst: 5, legacyGst: 18, unit: "PKT", rate: [70, 78], mrp: 90, qty: [12, 48] },
  { en: "Britannia Good Day 600g", hi: "ब्रिटानिया गुड डे 600 ग्रा.", hsn: "19053100", gst: 5, legacyGst: 18, unit: "PKT", rate: [118, 132], mrp: 150, qty: [6, 24] },
  { en: "Maggi Noodles 12-pack", hi: "मैगी नूडल्स 12 पैक", hsn: "19023010", gst: 5, legacyGst: 12, unit: "PKT", rate: [150, 162], mrp: 180, qty: [6, 30] },
  { en: "Amul Butter 500g", hi: "अमूल मक्खन 500 ग्रा.", hsn: "04051000", gst: 5, legacyGst: 12, unit: "PCS", rate: [248, 262], mrp: 285, qty: [6, 24] },
  { en: "Amul Pure Ghee 1L", hi: "अमूल शुद्ध घी 1 ली.", hsn: "04059020", gst: 5, legacyGst: 12, unit: "TIN", rate: [560, 610], mrp: 675, qty: [4, 20] },
  { en: "Toned Milk 500ml", hi: "टोंड दूध 500 मि.ली.", hsn: "04012000", gst: 0, unit: "PKT", rate: [26, 28], mrp: 30, qty: [50, 200] },
  { en: "Paneer 200g", hi: "पनीर 200 ग्रा.", hsn: "04061000", gst: 0, legacyGst: 5, unit: "PKT", rate: [78, 88], mrp: 95, qty: [10, 40] },
  { en: "Surf Excel Easy Wash 1kg", hi: "सर्फ एक्सेल ईज़ी वॉश 1 कि.ग्रा.", hsn: "34022090", gst: 18, legacyGst: 28, unit: "PKT", rate: [112, 124], mrp: 145, qty: [10, 40] },
  { en: "Vim Dishwash Bar 300g", hi: "विम बर्तन साबुन 300 ग्रा.", hsn: "34011190", gst: 5, legacyGst: 18, unit: "PCS", rate: [24, 28], mrp: 32, qty: [24, 96] },
  { en: "Lifebuoy Soap 4x100g", hi: "लाइफबॉय साबुन 4x100 ग्रा.", hsn: "34011190", gst: 5, legacyGst: 18, unit: "PKT", rate: [118, 130], mrp: 152, qty: [6, 36] },
  { en: "Colgate Strong Teeth 200g", hi: "कोलगेट टूथपेस्ट 200 ग्रा.", hsn: "33061020", gst: 5, legacyGst: 18, unit: "PCS", rate: [96, 108], mrp: 125, qty: [12, 48] },
  { en: "Clinic Plus Shampoo 340ml", hi: "क्लिनिक प्लस शैम्पू 340 मि.ली.", hsn: "33051090", gst: 5, legacyGst: 18, unit: "BTL", rate: [168, 186], mrp: 220, qty: [6, 24] },
  { en: "Harpic Toilet Cleaner 1L", hi: "हार्पिक टॉयलेट क्लीनर 1 ली.", hsn: "34029099", gst: 18, unit: "BTL", rate: [168, 184], mrp: 215, qty: [6, 24] },
  { en: "Good Knight Refill 45ml", hi: "गुड नाइट रिफिल 45 मि.ली.", hsn: "38089199", gst: 18, unit: "PCS", rate: [64, 72], mrp: 85, qty: [12, 48] },
  { en: "Coca-Cola 750ml", hi: "कोका-कोला 750 मि.ली.", hsn: "22021010", gst: 40, legacyGst: 28, unit: "BTL", rate: [24, 28], mrp: 40, qty: [24, 96] },
  { en: "Thums Up 2L", hi: "थम्स अप 2 ली.", hsn: "22021010", gst: 40, legacyGst: 28, unit: "BTL", rate: [52, 58], mrp: 95, qty: [12, 48] },
  { en: "Kurkure Masala Munch 90g", hi: "कुरकुरे मसाला मंच 90 ग्रा.", hsn: "21069099", gst: 5, legacyGst: 12, unit: "PKT", rate: [15, 17], mrp: 20, qty: [24, 120] },
  { en: "Dairy Milk Silk 60g", hi: "डेयरी मिल्क सिल्क 60 ग्रा.", hsn: "18063200", gst: 5, legacyGst: 18, unit: "PCS", rate: [62, 68], mrp: 80, qty: [12, 60] },
  { en: "Eggs (Tray of 30)", hi: "अंडे (30 की ट्रे)", hsn: "04072100", gst: 0, unit: "TRAY", rate: [170, 195], qty: [5, 30] },
  { en: "Potato (Loose)", hi: "आलू (खुला)", hsn: "07019000", gst: 0, unit: "KG", rate: [18, 26], qty: [50, 300], loose: true },
  { en: "Onion (Loose)", hi: "प्याज़ (खुला)", hsn: "07031010", gst: 0, unit: "KG", rate: [28, 42], qty: [50, 250], loose: true },
  { en: "Poha Thick 1kg", hi: "पोहा मोटा 1 कि.ग्रा.", hsn: "19041090", gst: 5, unit: "PKT", rate: [58, 66], mrp: 78, qty: [10, 40] },
  { en: "Cashew W240 500g", hi: "काजू W240 500 ग्रा.", hsn: "08013220", gst: 5, unit: "PKT", rate: [420, 470], mrp: 560, qty: [4, 20] },
  { en: "Agarbatti Cycle 3-in-1", hi: "अगरबत्ती साइकिल 3-इन-1", hsn: "33074100", gst: 5, unit: "BOX", rate: [44, 50], mrp: 60, qty: [12, 48] },
  { en: "Pan Masala Rajnigandha 40g", hi: "पान मसाला रजनीगंधा 40 ग्रा.", hsn: "21069020", gst: 40, legacyGst: 28, unit: "PKT", rate: [148, 162], mrp: 210, qty: [10, 40] },
];

export const FREIGHT_LABELS = ["Freight", "Cartage", "Transport Charges", "Delivery Charges", "Packing & Forwarding"];
