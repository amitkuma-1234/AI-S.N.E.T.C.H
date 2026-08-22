/* =====================================================================
   S.N.E.T.C.H GLOBAL RESPONSIVE SIDEBAR LOGIC
   Automatically adds mobile toggle functionality to any page with a sidebar.
   ===================================================================== */

document.addEventListener("DOMContentLoaded", () => {
    // Find any sidebar on the page using the known class patterns
    const sidebar = document.querySelector('#sidebar, .sidebar, .aa-sidebar, .yt-sidebar, .ent-sidebar, .wd-sidebar, .img-sidebar, .doc-sidebar');
    
    // If no sidebar exists on this page, we don't need to do anything
    if (!sidebar) return;

    // Create the backdrop overlay for mobile
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    // Find the main content area to insert the mobile header
    const mainContent = document.querySelector('.main-content, .aa-main, .yt-main, .ent-main, .chat-container, .content-wrapper, .app-container');
    
    // Create the mobile header toggle (only visible on mobile via CSS)
    if (mainContent) {
        // Look for the page title from the sidebar brand to copy it
        let pageTitleText = "S.N.E.T.C.H";
        const brandTitle = document.querySelector('.brand, .brand-name, .brand-snetch, .aa-brand-name, .ent-brand-name');
        if (brandTitle) {
            pageTitleText = brandTitle.textContent.trim();
        }

        const mobileHeader = document.createElement('div');
        mobileHeader.className = 'snetch-mobile-header mobile-header-toggle';
        
        mobileHeader.innerHTML = `
            <button class="snetch-hamburger" aria-label="Toggle Menu">
                <i class="fa-solid fa-bars"></i>
            </button>
            <h1 class="snetch-header-title page-title-mobile">${pageTitleText}</h1>
        `;

        // Insert at the top of the main content
        mainContent.insertBefore(mobileHeader, mainContent.firstChild);

        // Toggle logic
        const hamburgerBtn = mobileHeader.querySelector('.snetch-hamburger');
        
        function toggleSidebar() {
            sidebar.classList.toggle('open');
            backdrop.classList.toggle('active');
        }

        hamburgerBtn.addEventListener('click', toggleSidebar);
        backdrop.addEventListener('click', toggleSidebar);

        // Also close sidebar if a nav link is clicked (useful for mobile)
        const navLinks = sidebar.querySelectorAll('a, .nav-item, .chat-item, .ent-chat-item');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 1024) {
                    sidebar.classList.remove('open');
                    backdrop.classList.remove('active');
                }
            });
        });
    }
});
